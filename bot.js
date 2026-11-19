// ==============================================================================
// FloodBot - Bot de WhatsApp para Reporte Ciudadano de Inundaciones Urbanas
// ==============================================================================
// Arquitectura Simplificada y Segura:
// - Conexión directa a WhatsApp mediante Baileys (sin servidor web / sin puertos abiertos)
// - Vinculación interactiva segura desde CMD (Pairing Code)
// - Máquina de estados conversacional para recopilar: GPS, Foto, Afectaciones y Descripción
// - Persistencia de estados locales en SQLite (sessions.db)
// - Sincronización asíncrona hacia Supabase (Storage: reportes/whatsapp/ + DB: reportes_whatsapp)
// ==============================================================================

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const Database = require('better-sqlite3')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    downloadMediaMessage,
    decryptPollVote,
    getContentType,
    jidNormalizedUser,
    getKeyAuthor,
    proto,
    generateWAMessageFromContent,
    generateMessageID
} = require('@whiskeysockets/baileys')

const {
    uploadReportPhoto,
    insertReportRecord,
    updateReportRecord,
    deleteReportRecord,
    syncReportToSupabase,
    isSupabaseConfigured
} = require('./supabaseClient')
const { defaultQueue, OUTGOING_RATE_LIMIT_MS } = require('./messageQueue')

// Función centralizada para enviar mensajes salientes a través de la cola con Rate Limiting
function sendQueuedMessage(sock, jid, content, options = {}) {
    if (sock && sock !== defaultQueue.getSocket()) {
        defaultQueue.setSocket(sock)
    }
    const msgId = options.messageId || ('BOT_' + (typeof generateMessageID === 'function' ? generateMessageID() : crypto.randomUUID()))
    recordBotOutgoingMessageId(msgId)
    const sendOptions = { ...options, messageId: msgId }

    return defaultQueue.enqueue(jid, content, sendOptions).then(result => {
        if (result?.key?.id) {
            recordBotOutgoingMessageId(result.key.id)
        }
        return result
    })
}

// Silenciar avisos criptográficos internos de bajo nivel de libsignal (SessionEntry, buffers)
const _originalConsoleInfo = console.info
console.info = (...args) => {
    const firstArg = typeof args[0] === 'string' ? args[0] : ''
    if (
        firstArg.includes('Closing session') ||
        firstArg.includes('Opening session') ||
        firstArg.includes('Removing old closed session') ||
        firstArg.includes('Closing open session')
    ) {
        return
    }
    _originalConsoleInfo.apply(console, args)
}

// Directorios y persistencia local (configurables por entorno para aislamiento de pruebas)
const AUTH_DIR = process.env.AUTH_DIR || path.resolve(__dirname, 'auth_info_baileys')
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(__dirname, 'uploads')
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, 'sessions.db')

// Tiempo máximo de inactividad por usuario (15 minutos en milisegundos)
const SESSION_TIMEOUT_MS = 15 * 60 * 1000
const FINAL_SUCCESS_MESSAGE = `✅ *¡Reporte recibido correctamente!*\n\n¡Muchas gracias por tu colaboración! 🙌\n\nTu reporte contribuirá al monitoreo de inundaciones urbanas y a la identificación de zonas afectadas.\n\n🗺️ *¡Explorá nuestro mapa interactivo!*\n\nPodés visualizar los reportes de inundaciones en nuestra plataforma web:\n\n🔗 https://monitoreoinundaciones.vercel.app`

// Tiempo máximo de inactividad de una atención manual activa sin cierre del asesor (2 horas de seguridad)
const ADVISOR_ACTIVE_TIMEOUT_MS = 2 * 60 * 60 * 1000

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

// Inicialización de SQLite para gestión de estados conversacionales y reportes pendientes
const db = new Database(DB_PATH)
db.exec(`
    CREATE TABLE IF NOT EXISTS report_sessions (
        user_jid TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        selected_affectations TEXT DEFAULT '[]',
        photo_path TEXT,
        description TEXT,
        poll_msg_id TEXT,
        poll_enc_key TEXT,
        report_id TEXT,
        storage_url TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_sync_reports (
        id TEXT PRIMARY KEY,
        user_jid TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        selected_affectations TEXT DEFAULT '[]',
        photo_path TEXT,
        description TEXT,
        storage_url TEXT,
        status TEXT DEFAULT 'PENDING',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        next_retry_at INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS advisor_sessions (
        user_jid TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        closed_at_ms INTEGER,
        last_activity_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS bot_outgoing_messages (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`)

// Migraciones seguras para bases de datos existentes
try {
    db.prepare('ALTER TABLE report_sessions ADD COLUMN report_id TEXT').run()
} catch (_) { }
try {
    db.prepare('ALTER TABLE report_sessions ADD COLUMN storage_url TEXT').run()
} catch (_) { }
try {
    db.prepare('ALTER TABLE advisor_sessions ADD COLUMN last_activity_ms INTEGER').run()
} catch (_) { }

// Helper de logging local
function addLog(type, message) {
    try {
        db.prepare('INSERT INTO audit_logs (type, message) VALUES (?, ?)').run(type, message)
    } catch (_) { }
    const time = new Date().toLocaleTimeString()
    console.log(`[${time}] [${type.toUpperCase()}] ${message}`)
}

// Helper para convertir el updated_at de SQLite a milisegundos UTC
function parseSessionUtcTimestamp(updatedAt) {
    if (!updatedAt) return 0
    if (typeof updatedAt === 'number') {
        return updatedAt < 10000000000 ? updatedAt * 1000 : updatedAt
    }
    if (typeof updatedAt === 'string') {
        const trimmed = updatedAt.trim()
        if (/^\d+$/.test(trimmed)) {
            const num = parseInt(trimmed, 10)
            return num < 10000000000 ? num * 1000 : num
        }
        // SQLite CURRENT_TIMESTAMP siempre genera "YYYY-MM-DD HH:MM:SS" en UTC
        if (trimmed.includes(' ') && !trimmed.endsWith('Z')) {
            return new Date(trimmed.replace(' ', 'T') + 'Z').getTime()
        }
        return new Date(trimmed).getTime()
    }
    return 0
}

// Verifica si una sesión ha superado los 30 minutos de inactividad
function isSessionExpired(session) {
    if (!session || !session.updated_at) return false
    const lastActiveMs = parseSessionUtcTimestamp(session.updated_at)
    if (!lastActiveMs || isNaN(lastActiveMs)) return false
    return (Date.now() - lastActiveMs) >= SESSION_TIMEOUT_MS
}

// Eliminación segura de archivos temporales verificando pertenencia a uploads/ y sin interrumpir el bot
function safeDeleteUploadFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return false
    try {
        if (!fs.existsSync(filePath)) return false

        // Resolver directorio uploads canónico y destino canónico para evitar traversal y symlinks
        const canonicalUploads = fs.realpathSync(UPLOADS_DIR)
        const canonicalTarget = fs.realpathSync(filePath)

        // Comprobar relación relativa estricta
        const rel = path.relative(canonicalUploads, canonicalTarget)
        const isInside = rel && !rel.startsWith('..') && !path.isAbsolute(rel)

        if (!isInside) {
            addLog('warn', `Intento de eliminación fuera de uploads/ rechazado: ${filePath} -> ${canonicalTarget}`)
            return false
        }

        const stat = fs.statSync(canonicalTarget)
        if (stat.isDirectory()) {
            addLog('warn', `Intento de eliminar un directorio rechazado: ${canonicalTarget}`)
            return false
        }

        fs.unlinkSync(canonicalTarget)
        addLog('info', `🧹 Archivo temporal eliminado con seguridad: ${path.basename(canonicalTarget)}`)
        return true
    } catch (err) {
        // Envoltorio seguro: nunca lanzar excepción ni detener el flujo del bot
        addLog('error', `Error controlado al intentar eliminar ${filePath}: ${err.message}`)
        return false
    }
}

// Elimina la sesión conversacional en SQLite SIN eliminar el archivo físico de fotografía
function deleteSessionWithoutPhoto(userJid) {
    try {
        db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(userJid)
    } catch (err) {
        addLog('error', `Error al eliminar sesión (sin foto) de ${userJid}: ${err.message}`)
    }
}

// Elimina la sesión en SQLite y, si es un borrador previo al guardado automático, elimina su foto temporal
function deleteSession(userJid) {
    try {
        const current = db.prepare('SELECT photo_path, report_id FROM report_sessions WHERE user_jid = ?').get(userJid)
        // Solo eliminar foto si NO pertenece a un reporte ya registrado
        if (current?.photo_path && !current?.report_id) {
            safeDeleteUploadFile(current.photo_path)
        }
        db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(userJid)
    } catch (err) {
        addLog('error', `Error al eliminar sesión de ${userJid}: ${err.message}`)
    }
}

// Limpieza periódica y al inicio: elimina sesiones expiradas (>15 min) y fotos huérfanas en uploads/
async function cleanupExpiredSessionsAndFiles(customSock = null) {
    const sock = customSock || global.activeSock || defaultQueue.getSocket()
    try {
        const activePhotoPaths = new Set()
        let expiredCount = 0

        // 1. Sesiones de conversación activas
        const allSessions = db.prepare('SELECT user_jid, photo_path, report_id, updated_at FROM report_sessions').all()
        for (const s of allSessions) {
            // Si la conversación está en atención manual por asesor, verificar si superó las 2 horas de inactividad
            const advisor = getAdvisorSession(s.user_jid)
            if (advisor && advisor.status === 'ACTIVE') {
                if (isAdvisorSessionExpired(advisor)) {
                    clearAdvisorSession(s.user_jid)
                    addLog('info', `⏰ Atención manual expirada por inactividad (>2h) para ${s.user_jid}. Sesión de asesor liberada.`)
                } else {
                    if (s.photo_path) {
                        try { activePhotoPaths.add(path.resolve(s.photo_path)) } catch (_) { }
                    }
                    continue
                }
            }

            if (isSessionExpired(s)) {
                // Eliminar sesión conversacional de inmediato para que nunca se procese dos veces
                db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(s.user_jid)
                expiredCount++

                if (s.report_id) {
                    // Reporte registrado con ubicación y fotografía: conservar reporte y foto
                    addLog('info', `⏰ Sesión expirada para ${s.user_jid}. Reporte ${s.report_id} conservado en cola/Supabase.`)
                    if (sock) {
                        try {
                            await sendQueuedMessage(sock, s.user_jid, { text: FINAL_SUCCESS_MESSAGE })
                        } catch (sendErr) {
                            addLog('warn', `No se pudo enviar mensaje de expiración a ${s.user_jid}: ${sendErr.message}`)
                        }
                    }
                } else {
                    // Borrador incompleto (no llegó a foto válida): descartar
                    if (s.photo_path) {
                        safeDeleteUploadFile(s.photo_path)
                    }
                    addLog('info', `⏰ Borrador incompleto expirado para ${s.user_jid}. Sesión descartada.`)
                    if (sock) {
                        const draftExpireMsg = `⏱️ *Conversación finalizada*\n\nLa conversación se cerró por inactividad.\n\nSi querés realizar un reporte, podés volver a escribir *REPORTAR* cuando quieras.`
                        try {
                            await sendQueuedMessage(sock, s.user_jid, { text: draftExpireMsg })
                        } catch (sendErr) {
                            addLog('warn', `No se pudo enviar mensaje de expiración a ${s.user_jid}: ${sendErr.message}`)
                        }
                    }
                }
            } else if (s.photo_path) {
                // Sesión activa: registrar su fotografía para que NUNCA sea eliminada
                try {
                    activePhotoPaths.add(path.resolve(s.photo_path))
                } catch (_) { }
            }
        }

        if (expiredCount > 0) {
            addLog('info', `🧹 Limpieza: ${expiredCount} sesión(es) expirada(s) procesada(s) por inactividad.`)
        }

        // 1.b. Sesiones de asesor activas que hayan superado las 2 horas de inactividad
        try {
            const allAdvisors = db.prepare("SELECT user_jid, status, started_at, last_activity_ms FROM advisor_sessions WHERE status = 'ACTIVE'").all()
            for (const adv of allAdvisors) {
                if (isAdvisorSessionExpired(adv)) {
                    clearAdvisorSession(adv.user_jid)
                    addLog('info', `⏰ Atención manual expirada por inactividad (>2h) para ${adv.user_jid}. Sesión de asesor liberada.`)
                }
            }
        } catch (_) { }

        // 2. Reportes confirmados / auto-guardados pendientes de sincronización (NUNCA deben eliminarse sus fotos)
        try {
            const pendingReports = db.prepare('SELECT photo_path FROM pending_sync_reports WHERE photo_path IS NOT NULL').all()
            for (const p of pendingReports) {
                if (p.photo_path) {
                    activePhotoPaths.add(path.resolve(p.photo_path))
                }
            }
        } catch (_) { }

        // 3. Inspeccionar archivos en uploads/
        if (fs.existsSync(UPLOADS_DIR)) {
            const files = fs.readdirSync(UPLOADS_DIR)
            const now = Date.now()

            for (const file of files) {
                const fullPath = path.resolve(UPLOADS_DIR, file)
                // CONDICIÓN ESTRICTA: Solo eliminar si NO pertenece a una sesión activa NI a un reporte pendiente
                if (!activePhotoPaths.has(fullPath)) {
                    try {
                        const stat = fs.statSync(fullPath)
                        // Si está huérfana y tiene más de 15 minutos de antigüedad (margen de seguridad)
                        if (now - stat.mtimeMs >= SESSION_TIMEOUT_MS) {
                            safeDeleteUploadFile(fullPath)
                        }
                    } catch (_) { }
                }
            }
        }

        // 4. Mantenimiento de registros de mensajes salientes y sesiones de asesor expiradas
        try {
            db.prepare("DELETE FROM bot_outgoing_messages WHERE created_at < datetime('now', '-24 hours')").run()
            db.prepare("DELETE FROM advisor_sessions WHERE status = 'COOLDOWN' AND (? - closed_at_ms) > (24 * 60 * 60 * 1000)").run(Date.now())
        } catch (_) { }
    } catch (err) {
        addLog('error', `Error en mantenimiento de sesiones y archivos temporales: ${err.message}`)
    }
}

// Cálculo de demora con backoff progresivo para reintentos de sincronización
function getNextRetryDelayMs(attempts) {
    // Backoff progresivo: intento 1: 5s, 2: 15s, 3: 45s, 4: 120s, 5+: 300s (máximo 5 min)
    const delays = [5000, 15000, 45000, 120000, 300000]
    const idx = Math.min(Math.max((attempts || 1) - 1, 0), delays.length - 1)
    return delays[idx]
}

// Procesa la sincronización de un único reporte pendiente con Supabase
async function processSinglePendingReport(report, customSyncDependencies = null) {
    if (!report || !report.id) return { success: false, error: 'Reporte inválido' }

    const uploadPhotoFn = customSyncDependencies?.uploadReportPhoto || uploadReportPhoto
    const insertRecordFn = customSyncDependencies?.insertReportRecord || insertReportRecord
    const updateRecordFn = customSyncDependencies?.updateReportRecord || updateReportRecord
    const isConfiguredFn = customSyncDependencies?.isSupabaseConfigured || isSupabaseConfigured

    if (!isConfiguredFn()) {
        addLog('warn', `Supabase no está configurado. El reporte pendiente ${report.id} continuará en espera.`)
        return { success: false, error: 'Supabase no configurado' }
    }

    try {
        // CASO ESPECIAL: Actualización diferida de reporte ya insertado en Supabase
        // (preserva intacto el estado de verificación 'estado' y 'creado_en')
        if (report.status === 'PENDING_UPDATE') {
            const updateRes = await updateRecordFn(report.id, {
                description: report.description,
                selected_affectations: report.selected_affectations
            })

            if (!updateRes || !updateRes.success) {
                const updateErr = updateRes?.error || 'Fallo al actualizar en base de datos'
                const nextAttempts = (report.attempts || 0) + 1
                const nextRetry = Date.now() + getNextRetryDelayMs(nextAttempts)
                db.prepare(`
                    UPDATE pending_sync_reports
                    SET attempts = ?,
                        last_error = ?,
                        next_retry_at = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(nextAttempts, `DB Update: ${updateErr}`, nextRetry, report.id)
                addLog('warn', `⚠️ Fallo al actualizar reporte ${report.id} en DB (Intento ${nextAttempts}): ${updateErr}`)
                return { success: false, error: updateErr }
            }

            addLog('info', `☁️ Reporte ${report.id} actualizado exitosamente en Supabase DB`)
            db.prepare('DELETE FROM pending_sync_reports WHERE id = ?').run(report.id)
            return {
                success: true,
                reportId: report.id,
                isUpdate: true,
                remoteData: updateRes.data
            }
        }

        let photoPublicUrl = report.storage_url || null

        // Comprobación de existencia del archivo local
        const hasLocalFile = Boolean(report.photo_path && typeof report.photo_path === 'string' && fs.existsSync(report.photo_path))

        // Paso A: Subida de fotografía a Storage (si aún no tiene storage_url)
        if (!photoPublicUrl) {
            if (hasLocalFile) {
                const uploadRes = await uploadPhotoFn(report.photo_path)
                if (uploadRes && uploadRes.success && uploadRes.publicUrl) {
                    photoPublicUrl = uploadRes.publicUrl
                    // Guardar de inmediato storage_url para evitar re-subidas duplicadas e inconsistencias
                    db.prepare(`
                        UPDATE pending_sync_reports
                        SET storage_url = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(photoPublicUrl, report.id)
                    try {
                        db.prepare('UPDATE report_sessions SET storage_url = ? WHERE report_id = ?').run(photoPublicUrl, report.id)
                    } catch (_) { }
                    addLog('info', `📸 Foto de reporte ${report.id} subida a Storage: ${photoPublicUrl}`)
                } else {
                    const uploadErr = uploadRes?.error || 'Fallo al subir a Storage'
                    const nextAttempts = (report.attempts || 0) + 1
                    const nextRetry = Date.now() + getNextRetryDelayMs(nextAttempts)
                    db.prepare(`
                        UPDATE pending_sync_reports
                        SET attempts = ?,
                            last_error = ?,
                            next_retry_at = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(nextAttempts, `Storage: ${uploadErr}`, nextRetry, report.id)
                    addLog('warn', `⚠️ Fallo al subir foto de reporte ${report.id} (Intento ${nextAttempts}): ${uploadErr}`)
                    return { success: false, error: uploadErr }
                }
            } else {
                // IMPEDIR REPORTES SIN FOTOGRAFÍA: La fotografía es obligatoria.
                // Si el archivo local no existe y tampoco tenemos URL en Storage, no insertar el reporte incompleto.
                const missingPhotoErr = `Fotografía obligatoria no disponible (ruta local no encontrada: ${report.photo_path || 'ninguna'} y sin storage_url)`
                addLog('error', `⛔ Reporte ${report.id} retenido: ${missingPhotoErr}. No se inserta en Supabase.`)

                db.prepare(`
                    UPDATE pending_sync_reports
                    SET status = 'FAILED_MISSING_PHOTO',
                        last_error = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(missingPhotoErr, report.id)

                return { success: false, error: missingPhotoErr, missingPhoto: true }
            }
        }

        // Validación final de seguridad antes del INSERT: bajo ninguna circunstancia insertar sin photoPublicUrl
        if (!photoPublicUrl) {
            const noUrlErr = 'Fotografía obligatoria: no se obtuvo URL válida de Storage'
            db.prepare(`
                UPDATE pending_sync_reports
                SET status = 'FAILED_MISSING_PHOTO',
                    last_error = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(noUrlErr, report.id)
            return { success: false, error: noUrlErr, missingPhoto: true }
        }

        // Paso B: Inserción idempotente en la base de datos de Supabase utilizando el UUID persistente
        const insertRes = await insertRecordFn({
            id: report.id, // UUID compartido persistente entre SQLite y Supabase
            latitude: report.latitude,
            longitude: report.longitude,
            description: report.description,
            selected_affectations: report.selected_affectations,
            photoUrl: photoPublicUrl,
            estado: 'pendiente',
            archivo_tipo: 'image/jpeg'
        })

        if (!insertRes || !insertRes.success) {
            const dbErr = insertRes?.error || 'Fallo al insertar en base de datos'
            const nextAttempts = (report.attempts || 0) + 1
            const nextRetry = Date.now() + getNextRetryDelayMs(nextAttempts)
            db.prepare(`
                UPDATE pending_sync_reports
                SET attempts = ?,
                    last_error = ?,
                    next_retry_at = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(nextAttempts, `DB: ${dbErr}`, nextRetry, report.id)
            addLog('warn', `⚠️ Fallo al registrar reporte ${report.id} en DB (Intento ${nextAttempts}): ${dbErr}`)
            return { success: false, error: dbErr, storageUrlSaved: Boolean(photoPublicUrl) }
        }

        // Paso C: Éxito total (Storage + DB completados)
        addLog('info', `☁️ Reporte ${report.id} sincronizado exitosamente con Supabase DB`)

        // 1. Eliminar la fotografía local si existía
        if (report.photo_path) {
            safeDeleteUploadFile(report.photo_path)
        }

        // 2. Eliminar el registro pendiente de SQLite
        db.prepare('DELETE FROM pending_sync_reports WHERE id = ?').run(report.id)

        return {
            success: true,
            reportId: report.id,
            publicUrl: photoPublicUrl,
            remoteData: insertRes.data
        }

    } catch (err) {
        const nextAttempts = (report.attempts || 0) + 1
        const nextRetry = Date.now() + getNextRetryDelayMs(nextAttempts)
        try {
            db.prepare(`
                UPDATE pending_sync_reports
                SET attempts = ?,
                    last_error = ?,
                    next_retry_at = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(nextAttempts, `Excepción: ${err.message}`, nextRetry, report.id)
        } catch (_) { }
        addLog('error', `⚠️ Excepción procesando sincronización de reporte ${report.id}: ${err.message}`)
        return { success: false, error: err.message }
    }
}

// Helper para sincronizar progresivamente los cambios de afectaciones y descripción
async function updateSavedReportData(sender, customDependencies = null) {
    try {
        const session = db.prepare('SELECT report_id, latitude, longitude, selected_affectations, description, storage_url FROM report_sessions WHERE user_jid = ?').get(sender)
        if (!session || !session.report_id) return

        const pending = db.prepare('SELECT id, status, storage_url FROM pending_sync_reports WHERE id = ?').get(session.report_id)

        if (pending) {
            // El reporte aún reside en la cola de sincronización pendiente:
            // actualizar directamente la fila para que el envío lleve la información más reciente
            db.prepare(`
                UPDATE pending_sync_reports
                SET selected_affectations = ?,
                    description = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                session.selected_affectations || '[]',
                session.description || 'Sin descripción',
                session.report_id
            )
            addLog('info', `Datos consolidados en cola pendiente para reporte ${session.report_id}`)
        } else {
            // El reporte básico inicial ya fue insertado en Supabase: actualizar remotamente
            // sin tocar las columnas 'estado' ni 'creado_en'
            const updateRecordFn = customDependencies?.updateReportRecord || updateReportRecord
            const updateRes = await updateRecordFn(session.report_id, {
                description: session.description,
                selected_affectations: session.selected_affectations
            })

            if (!updateRes || !updateRes.success) {
                // Si la actualización inmediata falla (ej: fallo de red temporal), encolar en pending_sync_reports con status PENDING_UPDATE
                const errDetail = updateRes?.error || 'Fallo de actualización remota'
                addLog('warn', `No se pudo actualizar de inmediato en Supabase (${errDetail}). Encolando en pending_sync_reports para reintento: ${session.report_id}`)
                db.prepare(`
                    INSERT INTO pending_sync_reports (
                        id, user_jid, latitude, longitude, selected_affectations, photo_path, description, storage_url, status, attempts, next_retry_at, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'PENDING_UPDATE', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET
                        selected_affectations = excluded.selected_affectations,
                        description = excluded.description,
                        status = 'PENDING_UPDATE',
                        updated_at = CURRENT_TIMESTAMP
                `).run(
                    session.report_id,
                    sender,
                    session.latitude,
                    session.longitude,
                    session.selected_affectations || '[]',
                    session.description || 'Sin descripción',
                    session.storage_url || null
                )
            } else {
                addLog('info', `Reporte ${session.report_id} actualizado exitosamente en Supabase`)
            }
        }
    } catch (err) {
        addLog('error', `Error al actualizar datos de reporte guardado para ${sender}: ${err.message}`)
    }
}

// Orquestador para sincronizar reportes pendientes listos para reintento
let isSyncingPendingReports = false
async function triggerSyncPendingReports(customDependencies = null) {
    if (isSyncingPendingReports) return
    isSyncingPendingReports = true

    try {
        const nowMs = Date.now()
        const pendingReports = db.prepare(`
            SELECT id, user_jid, latitude, longitude, selected_affectations, photo_path, description, storage_url, status, attempts, next_retry_at
            FROM pending_sync_reports
            WHERE status IN ('PENDING', 'PENDING_UPDATE') AND next_retry_at <= ?
            ORDER BY created_at ASC
            LIMIT 10
        `).all(nowMs)

        for (const report of pendingReports) {
            await processSinglePendingReport(report, customDependencies)
        }
    } catch (err) {
        addLog('error', `Error en triggerSyncPendingReports: ${err.message}`)
    } finally {
        isSyncingPendingReports = false
    }
}

// Categorías oficiales de afectación de la plataforma de monitoreo
const AFFECTATION_CATEGORIES = [
    "Calle inundada",
    "Deslizamiento",
    "Árbol caído",
    "Vivienda afectada",
    "Vehículo afectado",
    "Persona atrapada",
    "Fallecimiento reportado",
    "Interrupción de tránsito",
    "Servicio público afectado",
    "Sin daños visibles",
    "Acumulación de basura"
]

// Helper para desenrollar mensajes de Baileys
function getRawMessage(msg) {
    if (!msg || !msg.message) return null
    let message = msg.message
    if (message.ephemeralMessage) message = message.ephemeralMessage.message
    if (message.viewOnceMessage) message = message.viewOnceMessage.message
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message
    return message
}

// Helper para entrada por consola (CMD)
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })
    return new Promise(resolve => rl.question(query, ans => {
        rl.close()
        resolve(ans.trim())
    }))
}

// ==============================================================================
// CONFIGURACIÓN DE INTERFAZ DE CONFIRMACIÓN (ENCUESTA INTERACTIVA NATIVA)
// ==============================================================================
// Modalidades admitidas para la confirmación del reporte:
// - 'POLL': Resumen de texto + Encuesta interactiva nativa de 2 opciones ('1. Confirmar y enviar' y '0. Cancelar').
// - 'TEXT': Mensaje tradicional de texto plano ("Respondé 1 o CONFIRMAR...").
const CONFIRMATION_INTERFACE_MODE = 'POLL'

// Registro en memoria de encuestas activas para asociar ID con su clave de descifrado y tipo
if (!global.pollRegistry) global.pollRegistry = new Map()

// Genera el texto del resumen del reporte
function getReportSummaryText(currentSession) {
    let affectationsList = []
    try {
        if (currentSession?.selected_affectations) {
            affectationsList = typeof currentSession.selected_affectations === 'string'
                ? JSON.parse(currentSession.selected_affectations)
                : currentSession.selected_affectations
        }
    } catch (_) { }

    const affectationsStr = affectationsList.length > 0
        ? affectationsList.join(', ')
        : 'Ninguna'

    const descStr = currentSession?.description && currentSession.description.trim().length > 0 && currentSession.description.trim() !== 'Sin descripción'
        ? currentSession.description.trim()
        : 'No proporcionada'

    const coordsStr = (currentSession?.latitude != null && currentSession?.longitude != null)
        ? `${currentSession.latitude.toFixed(6)}, ${currentSession.longitude.toFixed(6)}`
        : 'No registrada'

    return `📋 *Resumen de tu reporte*\n\n` +
        `📍 *Ubicación:* ${coordsStr}\n` +
        `📸 *Fotografía:* Recibida ✅\n` +
        `⛈️ *Afectaciones:* ${affectationsStr}\n` +
        `✍️ *Descripción:* ${descStr}`
}

// ==============================================================================
// GESTIÓN Y EXTRACCIÓN SEGURA DE UBICACIONES MEDIANTE GOOGLE MAPS
// ==============================================================================

/**
 * Valida si un par de coordenadas es numéricamente válido y está dentro de los límites geográficos
 */
function isValidCoordinate(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return false
    if (isNaN(lat) || isNaN(lng) || !isFinite(lat) || !isFinite(lng)) return false
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/**
 * Valida si un host pertenece a los dominios oficiales de Google Maps (SSRF protection)
 */
function isAllowedGoogleMapsHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return false
    const host = hostname.toLowerCase()

    if (host === 'maps.app.goo.gl' || host === 'goo.gl') return true
    if (host === 'maps.google.com' || host === 'maps.google.com.py' || host === 'maps.google.com.ar') return true

    // Coincide con google.com o google.<tld> o subdominios autorizados (maps, www)
    const isGoogle = /^([a-z0-9-]+\.)?google\.(?:com|[a-z]{2})(?:\.[a-z]{2})?$/.test(host)
    return isGoogle
}

/**
 * Extrae una URL de Google Maps contenida en un texto de mensaje
 */
function extractGoogleMapsUrlFromText(text) {
    if (!text || typeof text !== 'string') return null
    const urlRegex = /https?:\/\/[^\s<>"]+/i
    const match = text.match(urlRegex)
    if (!match) return null

    try {
        const parsed = new URL(match[0])
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        if (!isAllowedGoogleMapsHost(parsed.hostname)) return null
        return match[0]
    } catch (_) {
        return null
    }
}

/**
 * Extrae coordenadas del marcador/lugar seleccionado a partir de una URL resuelta de Google Maps.
 * IMPORTANTE: Prioriza el marcador seleccionado (!3d/!4d o query q/ll) y NO acepta automáticamente
 * coordenadas de la vista de cámara (@lat,lng), evitando ubicaciones erróneas.
 */
function extractCoordinatesFromResolvedUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null

    try {
        // 1. Prioridad 1: Marcador de lugar o punto seleccionado en parámetros protobuf (!3d<lat>!4d<lng>)
        const markerMatch = urlStr.match(/!3d(-?\d+(?:\.\d+)?).*?!4d(-?\d+(?:\.\d+)?)/)
        if (markerMatch) {
            const lat = parseFloat(markerMatch[1])
            const lng = parseFloat(markerMatch[2])
            if (isValidCoordinate(lat, lng)) {
                return { lat, lng }
            }
        }

        const parsed = new URL(urlStr)

        // 2. Prioridad 2: Coordenadas explícitas en parámetros de consulta (q, query, daddr, ll)
        const candidateParams = ['q', 'query', 'daddr', 'll']
        for (const param of candidateParams) {
            const val = parsed.searchParams.get(param)
            if (val) {
                const cleanVal = val.replace(/^loc:\s*/i, '')
                const coordsMatch = cleanVal.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/)
                if (coordsMatch) {
                    const lat = parseFloat(coordsMatch[1])
                    const lng = parseFloat(coordsMatch[2])
                    if (isValidCoordinate(lat, lng)) {
                        return { lat, lng }
                    }
                }
            }
        }

        // 3. Prioridad 3: Coordenadas en la ruta de place (/place/-25.299045,-57.532044)
        const placePathMatch = parsed.pathname.match(/\/place\/(-?\d+\.\d+)[,+ ]+(-?\d+\.\d+)/)
        if (placePathMatch) {
            const lat = parseFloat(placePathMatch[1])
            const lng = parseFloat(placePathMatch[2])
            if (isValidCoordinate(lat, lng)) {
                return { lat, lng }
            }
        }

        // NO se extrae de /@lat,lng/ porque representa el centro de visualización de cámara,
        // no un marcador de incidente confirmado.
        return null
    } catch (_) {
        return null
    }
}

/**
 * Resuelve enlaces cortos de Google Maps de forma segura, siguiendo redirecciones permitidas
 * y con protección contra SSRF y bucles infinitos.
 */
async function resolveGoogleMapsUrl(rawUrl, customFetch = null) {
    const fetchFn = customFetch || global.fetch || fetch
    if (typeof fetchFn !== 'function') return rawUrl

    let currentUrl = rawUrl
    let redirectCount = 0
    const maxRedirects = 4

    while (redirectCount < maxRedirects) {
        try {
            const parsed = new URL(currentUrl)
            if (!isAllowedGoogleMapsHost(parsed.hostname)) {
                // Destino no autorizado (protección SSRF)
                return null
            }

            // Si la URL actual ya tiene coordenadas en sus parámetros o protobuf, no necesitamos seguir redirigiendo
            if (extractCoordinatesFromResolvedUrl(currentUrl)) {
                return currentUrl
            }

            // Si no es un acortador ni necesita resolución, retornar
            const isShortener = parsed.hostname === 'maps.app.goo.gl' || parsed.hostname === 'goo.gl'
            if (!isShortener && redirectCount > 0) {
                return currentUrl
            }

            let response = null
            try {
                response = await fetchFn(currentUrl, {
                    method: 'HEAD',
                    redirect: 'manual',
                    signal: AbortSignal.timeout(4000)
                })
            } catch (_) {
                response = null
            }

            if (!response || response.status === 405 || (response.status >= 200 && response.status < 300 && !response.headers?.get?.('location'))) {
                try {
                    response = await fetchFn(currentUrl, {
                        method: 'GET',
                        redirect: 'manual',
                        signal: AbortSignal.timeout(4000)
                    })
                } catch (_) {
                    response = null
                }
            }

            if (!response) return currentUrl

            const status = response.status
            if (status >= 300 && status < 400) {
                const location = response.headers?.get ? response.headers.get('location') : null
                if (!location) return currentUrl

                const nextUrl = new URL(location, currentUrl).href
                currentUrl = nextUrl
                redirectCount++
            } else if (status === 200) {
                if (response.url && response.url !== currentUrl) {
                    currentUrl = response.url
                    if (extractCoordinatesFromResolvedUrl(currentUrl)) return currentUrl
                }
                if (typeof response.text === 'function') {
                    try {
                        const textBody = await response.text()
                        const ogMatch = textBody.match(/property="og:url"\s+content="([^"]+)"/i) || textBody.match(/content="([^"]+)"\s+property="og:url"/i)
                        if (ogMatch && ogMatch[1]) {
                            return ogMatch[1]
                        }
                        const markerBodyMatch = textBody.match(/!3d(-?\d+(?:\.\d+)?).*?!4d(-?\d+(?:\.\d+)?)/)
                        if (markerBodyMatch) {
                            return textBody
                        }
                    } catch (_) { }
                }
                return currentUrl
            } else {
                return currentUrl
            }
        } catch (_) {
            return null
        }
    }

    return currentUrl
}

/**
 * Orquestador para extraer coordenadas de un mensaje de texto con enlace de Google Maps
 */
async function extractCoordinatesFromGoogleMaps(text, customFetch = null) {
    const foundUrl = extractGoogleMapsUrlFromText(text)
    if (!foundUrl) return null

    // 1. Intentar extracción directa si la URL ya contiene los parámetros
    const directCoords = extractCoordinatesFromResolvedUrl(foundUrl)
    if (directCoords) return directCoords

    // 2. Si es enlace corto o requiere resolución, resolver con seguridad
    const resolvedUrl = await resolveGoogleMapsUrl(foundUrl, customFetch)
    if (!resolvedUrl) return null

    return extractCoordinatesFromResolvedUrl(resolvedUrl)
}

// ==============================================================================
// GESTIÓN DE ATENCIÓN MANUAL POR ASESOR Y DETECCIÓN DE MENSAJES SALIENTES
// ==============================================================================

if (!global.botSentMessageIds) global.botSentMessageIds = new Set()

function recordBotOutgoingMessageId(msgId) {
    if (!msgId || typeof msgId !== 'string') return
    global.botSentMessageIds.add(msgId)
    if (global.botSentMessageIds.size > 10000) {
        const first = global.botSentMessageIds.values().next().value
        global.botSentMessageIds.delete(first)
    }
    try {
        db.prepare('INSERT OR IGNORE INTO bot_outgoing_messages (id) VALUES (?)').run(msgId)
    } catch (_) {}
}

function isBotOutgoingMessageId(msgId) {
    if (!msgId || typeof msgId !== 'string') return false
    if (global.botSentMessageIds?.has(msgId)) return true
    try {
        const row = db.prepare('SELECT id FROM bot_outgoing_messages WHERE id = ?').get(msgId)
        if (row) {
            global.botSentMessageIds.add(msgId)
            return true
        }
    } catch (_) {}
    return false
}

function isAdvisorClosingMessage(text) {
    if (!text || typeof text !== 'string') return false
    const normalized = text
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
    return /gracias\s*[.,;!:]*\s*reporte\s+recibido/i.test(normalized)
}

function getAdvisorSession(userJid) {
    if (!userJid) return null
    try {
        return db.prepare('SELECT user_jid, status, started_at, closed_at, closed_at_ms, last_activity_ms FROM advisor_sessions WHERE user_jid = ?').get(userJid) || null
    } catch (_) {
        return null
    }
}

function activateAdvisorSession(userJid, activityMs = Date.now()) {
    if (!userJid) return
    try {
        db.prepare(`
            INSERT INTO advisor_sessions (user_jid, status, started_at, closed_at, closed_at_ms, last_activity_ms)
            VALUES (?, 'ACTIVE', CURRENT_TIMESTAMP, NULL, NULL, ?)
            ON CONFLICT(user_jid) DO UPDATE SET
                status = 'ACTIVE',
                closed_at = NULL,
                closed_at_ms = NULL,
                started_at = CURRENT_TIMESTAMP,
                last_activity_ms = ?
        `).run(userJid, activityMs, activityMs)
    } catch (err) {
        addLog('error', `Error al activar sesión de asesor para ${userJid}: ${err.message}`)
    }
}

function touchAdvisorSessionActivity(userJid, activityMs = Date.now()) {
    if (!userJid) return
    try {
        db.prepare("UPDATE advisor_sessions SET last_activity_ms = ? WHERE user_jid = ? AND status = 'ACTIVE'").run(activityMs, userJid)
    } catch (_) { }
}

function isAdvisorSessionExpired(advisor) {
    if (!advisor || advisor.status !== 'ACTIVE') return false
    const lastActive = advisor.last_activity_ms || (advisor.started_at ? parseSessionUtcTimestamp(advisor.started_at) : 0)
    if (!lastActive) return false
    return (Date.now() - lastActive) >= ADVISOR_ACTIVE_TIMEOUT_MS
}

function closeAdvisorSession(userJid, closedAtMs = Date.now()) {
    if (!userJid) return
    try {
        db.prepare(`
            INSERT INTO advisor_sessions (user_jid, status, started_at, closed_at, closed_at_ms, last_activity_ms)
            VALUES (?, 'COOLDOWN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
            ON CONFLICT(user_jid) DO UPDATE SET
                status = 'COOLDOWN',
                closed_at = CURRENT_TIMESTAMP,
                closed_at_ms = ?,
                last_activity_ms = ?
        `).run(userJid, closedAtMs, closedAtMs, closedAtMs, closedAtMs)
    } catch (err) {
        addLog('error', `Error al cerrar sesión de asesor para ${userJid}: ${err.message}`)
    }
}

function clearAdvisorSession(userJid) {
    if (!userJid) return
    try {
        db.prepare('DELETE FROM advisor_sessions WHERE user_jid = ?').run(userJid)
    } catch (err) {
        addLog('error', `Error al limpiar sesión de asesor para ${userJid}: ${err.message}`)
    }
}

async function handleAdvisorOutgoingMessage(sock, recipientJid, msg) {
    const rawMsg = getRawMessage(msg)
    const text = (
        rawMsg?.conversation ||
        rawMsg?.extendedTextMessage?.text ||
        rawMsg?.imageMessage?.caption ||
        ''
    ).trim()

    // 1. Comprobar si es el mensaje de finalización ("Gracias. Reporte recibido")
    if (isAdvisorClosingMessage(text)) {
        closeAdvisorSession(recipientJid, Date.now())
        addLog('info', `Atención manual finalizada por asesor para ${recipientJid}. Cooldown de 15 min activado.`)
        return
    }

    // 2. Si es cualquier otro mensaje del asesor, activar modo asesor
    defaultQueue.cancelForJid(recipientJid)
    activateAdvisorSession(recipientJid)
    addLog('info', `Modo asesor activado para ${recipientJid}. FloodBot silenciado.`)

    // 3. Gestionar sesión conversacional previa
    try {
        const existingSession = db.prepare('SELECT state, photo_path, report_id FROM report_sessions WHERE user_jid = ?').get(recipientJid)
        if (existingSession) {
            if (!existingSession.report_id) {
                // Borrador incompleto: descartar foto temporal y eliminar sesión
                if (existingSession.photo_path) {
                    safeDeleteUploadFile(existingSession.photo_path)
                }
                db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(recipientJid)
                addLog('info', `Borrador incompleto descartado para ${recipientJid} por inicio de atención manual.`)
            } else {
                // Reporte ya auto-guardado: conservar en SQLite/Supabase y solo cerrar diálogo conversacional
                deleteSessionWithoutPhoto(recipientJid)
                addLog('info', `Reporte confirmado ${existingSession.report_id} conservado para ${recipientJid}. Sesión conversacional transferida a asesor.`)
            }
        }
    } catch (err) {
        addLog('error', `Error al gestionar sesión previa durante activación de asesor: ${err.message}`)
    }
}

// Envío de interfaz de confirmación de reporte (resumen + encuesta táctil o texto clásico)
async function sendReportConfirmationInterface(sock, sender, currentSession, modeOverride = null) {
    const mode = modeOverride || CONFIRMATION_INTERFACE_MODE
    const summaryText = getReportSummaryText(currentSession)

    if (mode === 'POLL') {
        try {
            await sendQueuedMessage(sock, sender, { text: summaryText })

            const confirmPollMsg = await sendQueuedMessage(sock, sender, {
                poll: {
                    name: '👉 ¿Confirmás los datos para enviar el reporte?',
                    values: ['1. Confirmar y enviar', '0. Cancelar'],
                    selectableCount: 1
                }
            })

            if (confirmPollMsg?.key?.id) {
                const messageSecret = confirmPollMsg.message?.messageContextInfo?.messageSecret
                if (messageSecret) {
                    const encKeyHex = Buffer.isBuffer(messageSecret)
                        ? messageSecret.toString('hex')
                        : Buffer.from(messageSecret, 'base64').toString('hex')

                    global.pollRegistry.set(confirmPollMsg.key.id, {
                        type: 'CONFIRMATION',
                        encKeyHex,
                        userJid: sender
                    })
                }
            }

            addLog('message_out', `Resumen y encuesta interactiva de confirmación enviada a ${sender}`)
            return confirmPollMsg
        } catch (err) {
            addLog('warn', `Fallo al enviar encuesta de confirmación (${err.message}). Utilizando texto alternativo.`)
        }
    }

    // Modo TEXT o Fallback seguro
    const classicSummary = summaryText + `\n\n¿Confirmás que los datos son correctos?\n\n` +
        `👉 Respondé *1* o *CONFIRMAR* para enviar.\n` +
        `👉 Respondé *0* o *CANCELAR* para salir.`

    const sent = await sendQueuedMessage(sock, sender, { text: classicSummary })
    addLog('message_out', `Resumen de reporte enviado para confirmación (modo texto clásico) a ${sender}`)
    return sent
}

// Ejecución segura de confirmación de reporte y consolidación de datos
async function executeReportConfirmation(sock, sender, session, customDependencies = null) {
    const confirmedSession = db.prepare('SELECT latitude, longitude, selected_affectations, photo_path, description, report_id, storage_url FROM report_sessions WHERE user_jid = ?').get(sender) || session

    // Validar coordenadas obligatorias
    if (confirmedSession.latitude == null || confirmedSession.longitude == null) {
        const invalidCoordsMsg = `No se detectaron coordenadas válidas para este reporte. Escribí *REPORTAR* para iniciar un reporte nuevo.`
        deleteSession(sender, customDependencies)
        await sendQueuedMessage(sock, sender, { text: invalidCoordsMsg })
        return true
    }

    let reportId = confirmedSession.report_id
    if (!reportId) {
        // Fallback para sesiones existentes que no hayan pasado por la auto-generación en AWAITING_PHOTO
        reportId = crypto.randomUUID()
        try {
            db.prepare(`
                INSERT INTO pending_sync_reports (
                    id, user_jid, latitude, longitude, selected_affectations, photo_path, description, status, attempts, next_retry_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(
                reportId,
                sender,
                confirmedSession.latitude,
                confirmedSession.longitude,
                confirmedSession.selected_affectations || '[]',
                confirmedSession.photo_path || null,
                confirmedSession.description || 'Sin descripción'
            )
        } catch (err) {
            addLog('error', `Fallo al registrar reporte en pending_sync_reports para ${sender}: ${err.message}`)
            const dbFailMsg = `⚠️ Ocurrió un error al registrar tu reporte localmente. Por favor respondé *1* para intentar confirmar nuevamente.`
            await sendQueuedMessage(sock, sender, { text: dbFailMsg })
            return true
        }
    } else {
        // Consolidar la actualización final en la cola / Supabase
        await updateSavedReportData(sender, customDependencies)
    }

    // 2. Solo tras guardar exitosamente en SQLite, cerrar la sesión conversacional SIN borrar la foto
    deleteSessionWithoutPhoto(sender)

    // 3. Enviar confirmación al usuario
    await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
    addLog('message_out', `Reporte confirmado por ${sender} (ID: ${reportId}). Sesión cerrada.`)

    // 4. Disparar sincronización asíncrona hacia Supabase (no bloquea al usuario)
    triggerSyncPendingReports(customDependencies).catch(syncErr => {
        addLog('error', `⚠️ Error al activar sincronización asíncrona: ${syncErr.message}`)
    })

    return true
}

// Envío de encuesta interactiva de WhatsApp para afectaciones y solicitud directa de descripción
async function sendAffectationPoll(sock, sender) {
    let pollMsgId = null
    let pollEncKeyHex = null

    try {
        const sentMsg = await sendQueuedMessage(sock, sender, {
            poll: {
                name: '⛈️ Seleccioná las afectaciones (Opcional):',
                values: AFFECTATION_CATEGORIES.map((cat, i) => `${i + 1}. ${cat}`),
                selectableCount: 0
            }
        })

        if (sentMsg) {
            pollMsgId = sentMsg.key?.id || null
            const messageSecret = sentMsg.message?.messageContextInfo?.messageSecret
            if (messageSecret) {
                pollEncKeyHex = Buffer.isBuffer(messageSecret)
                    ? messageSecret.toString('hex')
                    : Buffer.from(messageSecret, 'base64').toString('hex')
            }
        }
    } catch (e) {
        addLog('error', `Error al enviar encuesta de afectaciones: ${e.message}`)
    }

    if (pollMsgId && pollEncKeyHex) {
        db.prepare(`
            UPDATE report_sessions
            SET poll_msg_id = ?,
                poll_enc_key = ?
            WHERE user_jid = ?
        `).run(pollMsgId, pollEncKeyHex, sender)

        global.pollRegistry.set(pollMsgId, {
            type: 'AFFECTATIONS',
            encKeyHex: pollEncKeyHex,
            userJid: sender
        })
    }

    // Directamente al mensaje de descripción opcional (sin pregunta intermedia)
    const descPrompt = `✍️ *Descripción del incidente (opcional)*\n\n¿Querés agregar algún detalle sobre lo ocurrido?\n\n👉 Escribí tu descripción o respondé *1* para omitir.`
    await sendQueuedMessage(sock, sender, { text: descPrompt })
    addLog('message_out', `Solicitud de descripción enviada a ${sender}`)
}

// Control del flujo conversacional para el reporte de inundaciones
async function handleFloodReportFlow(sock, sender, msg, customDependencies = null) {
    const rawMsg = getRawMessage(msg)
    if (!rawMsg) return false

    let messageContent = ''
    if (rawMsg.conversation) {
        messageContent = rawMsg.conversation
    } else if (rawMsg.extendedTextMessage?.text) {
        messageContent = rawMsg.extendedTextMessage.text
    } else if (rawMsg.imageMessage?.caption) {
        messageContent = rawMsg.imageMessage.caption
    } else if (rawMsg.buttonsResponseMessage) {
        // Respuesta a botones clásicos
        messageContent = rawMsg.buttonsResponseMessage.selectedButtonId || rawMsg.buttonsResponseMessage.selectedDisplayText || ''
    } else if (rawMsg.templateButtonReplyMessage) {
        // Respuesta a template buttons
        messageContent = rawMsg.templateButtonReplyMessage.selectedId || rawMsg.templateButtonReplyMessage.selectedDisplayText || ''
    } else if (rawMsg.interactiveResponseMessage) {
        // Respuesta a Native Flow Buttons interactivos
        try {
            const paramsJson = rawMsg.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson
            if (paramsJson) {
                const parsed = JSON.parse(paramsJson)
                messageContent = parsed.id || parsed.display_text || ''
            }
        } catch (_) { }
    }

    const text = messageContent.trim()
    const lowerText = text.toLowerCase()

    // 1. Si el mensaje es saliente (fromMe: true)
    if (msg.key?.fromMe) {
        const msgId = msg.key?.id
        // Si fue originado por FloodBot, ignorar eco
        if (isBotOutgoingMessageId(msgId)) {
            return false
        }
        // Si NO fue originado por el bot, fue escrito personalmente por el asesor desde su WhatsApp
        await handleAdvisorOutgoingMessage(sock, sender, msg)
        return true
    }

    // 2. Si la conversación está en atención manual por asesor o en cooldown de 15 minutos
    const advisorSession = getAdvisorSession(sender)
    if (advisorSession) {
        if (advisorSession.status === 'ACTIVE') {
            if (isAdvisorSessionExpired(advisorSession)) {
                clearAdvisorSession(sender)
                addLog('info', `⏰ Atención manual expirada por inactividad (>2h) para ${sender}. Reactivando flujo automático.`)
            } else {
                touchAdvisorSessionActivity(sender)
                // Modo asesor activo: FloodBot permanece en silencio absoluto
                addLog('info', `Mensaje de ciudadano en conversación con asesor (silenciado): ${sender}`)
                return true
            }
        }

        if (advisorSession.status === 'COOLDOWN') {
            const elapsedMs = Date.now() - (advisorSession.closed_at_ms || 0)
            const isWithin15Min = elapsedMs < (15 * 60 * 1000)

            if (isWithin15Min) {
                const isExplicitReport = lowerText === 'reportar' || lowerText.startsWith('reportar')
                if (!isExplicitReport) {
                    // Respuestas de cortesía ("Gracias", etc.): silencio sin reiniciar temporizador
                    addLog('info', `Mensaje de ciudadano durante cooldown post-asesor (silenciado): ${sender}`)
                    return true
                }
                // Si el ciudadano escribe REPORTAR: reactivación inmediata
                clearAdvisorSession(sender)
                addLog('info', `Comando REPORTAR recibido durante cooldown. Reactivando flujo automático para ${sender}`)
            } else {
                // Pasaron más de 15 minutos desde el cierre: limpiar cooldown y permitir activación habitual
                clearAdvisorSession(sender)
                addLog('info', `Cooldown de 15 min expirado para ${sender}. Reactivando flujo automático.`)
            }
        }
    }

    // Debounce para evitar ráfagas repetidas
    if (!global.recentTriggers) global.recentTriggers = new Map()

    const session = db.prepare('SELECT state, latitude, longitude, selected_affectations, photo_path, description, poll_msg_id, poll_enc_key, report_id, storage_url, updated_at FROM report_sessions WHERE user_jid = ?').get(sender)

    // Helper para iniciar un reporte nuevo
    const startNewReport = async () => {
        clearAdvisorSession(sender)
        const lastTrigger = global.recentTriggers.get(sender) || 0
        const now = Date.now()
        if (now - lastTrigger < 3000) return true
        global.recentTriggers.set(sender, now)

        // Limpieza de foto temporal anterior solo si existía en una sesión previa no auto-guardada
        const prevSession = db.prepare('SELECT photo_path, report_id FROM report_sessions WHERE user_jid = ?').get(sender)
        if (prevSession?.photo_path && !prevSession?.report_id) {
            safeDeleteUploadFile(prevSession.photo_path)
        }

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, selected_affectations, updated_at)
            VALUES (?, 'AWAITING_LOCATION', '[]', CURRENT_TIMESTAMP)
            ON CONFLICT(user_jid) DO UPDATE SET
                state = 'AWAITING_LOCATION',
                latitude = NULL,
                longitude = NULL,
                selected_affectations = '[]',
                photo_path = NULL,
                description = NULL,
                poll_msg_id = NULL,
                poll_enc_key = NULL,
                report_id = NULL,
                storage_url = NULL,
                updated_at = CURRENT_TIMESTAMP
        `).run(sender)

        const welcomeMsg = `⛈️ *Sistema de Monitoreo de Inundaciones Urbanas* ⛈️\n\n¡Hola! 👋\n\nEste sistema busca recopilar información sobre inundaciones urbanas mediante la participación ciudadana. Tu reporte ayudará a identificar las zonas afectadas y mejorar el conocimiento sobre estos eventos.\n\nPara registrar tu reporte, te pediremos la siguiente información:\n\n📍 *Ubicación:* lugar donde ocurre la inundación.\n\n📸 *Fotografía:* imagen del lugar afectado.\n\n⛈️ *Afectaciones:* situaciones o daños observados.\n\n✍️ *Descripción (opcional):* información adicional sobre lo ocurrido.\n\nTu participación nos ayuda a identificar y conocer mejor las zonas afectadas por inundaciones.`

        const locationPrompt = `📍 *Paso 1: Ubicación*\n\nPor favor, compartí la ubicación del lugar donde está ocurriendo la inundación.\n\nPodés enviar tu ubicación actual o seleccionar otro punto en el mapa.\n\nPara cancelar el reporte, escribí *0*.`

        await sendQueuedMessage(sock, sender, { text: welcomeMsg })
        await sendQueuedMessage(sock, sender, { text: locationPrompt })
        addLog('message_out', `Bienvenida y solicitud de ubicación enviadas a ${sender}`)
        return true
    }

    // Comandos de reinicio manual (Inicio / Reiniciar / Empezar)
    const isRestartCommand = lowerText === 'inicio' || lowerText === 'reiniciar' || lowerText === 'empezar'

    // Comandos de cancelación manual o salida (Cancelar / 0 / Salir)
    const isCancelCommand = lowerText === 'cancelar' || text === '0' || lowerText === 'salir'

    // 1. Cancelación o salida global en cualquier momento
    if (isCancelCommand) {
        if (session?.report_id) {
            const currentSession = db.prepare('SELECT latitude, longitude, selected_affectations, photo_path, description, report_id, storage_url FROM report_sessions WHERE user_jid = ?').get(sender) || session
            const summaryText = getReportSummaryText(currentSession)
            await sendQueuedMessage(sock, sender, { text: summaryText })
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Salida de preguntas opcionales por usuario: ${sender}. Reporte ${session.report_id} conservado.`)
            return true
        }

        deleteSession(sender)
        const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
        await sendQueuedMessage(sock, sender, { text: cancelMsg })
        addLog('message_out', `Flujo cancelado por usuario: ${sender}`)
        return true
    }

    // 2. Reinicio manual en cualquier momento
    if (isRestartCommand) {
        deleteSession(sender)
        addLog('info', `Reinicio solicitado por usuario (${text}) para ${sender}`)
        return await startNewReport()
    }

    // Iniciar con comando explícito (salvo que sea un enlace de ubicación dentro de una sesión activa)
    const hasGoogleMapsUrl = extractGoogleMapsUrlFromText(text)
    if (!hasGoogleMapsUrl && (lowerText === 'reportar' || lowerText.includes('inundacion') || lowerText.includes('inundación'))) {
        return await startNewReport()
    }

    // Si no hay sesión previa, iniciar con el primer mensaje
    if (!session) {
        return await startNewReport()
    }

    // 3. Expiración por inactividad de 30 minutos:
    // Si pasaron 30 min o más desde la última interacción en UTC, se descarta silenciosamente
    // la sesión previa conversacional (sin mensajes automáticos de expiración) y se reinicia desde la bienvenida.
    // Si el usuario ya había enviado ubicación y fotografía válida, el reporte básico queda preservado.
    if (isSessionExpired(session)) {
        addLog('info', `Sesión expirada por inactividad (>30 min) para ${sender}. Reiniciando flujo conversacional (reporte preservado si existía).`)
        if (!session.report_id && session.photo_path) {
            safeDeleteUploadFile(session.photo_path)
        }
        db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(sender)
        return await startNewReport()
    }

    // Helper para mostrar resumen del reporte
    const sendReportSummary = async () => {
        const currentSession = db.prepare('SELECT latitude, longitude, selected_affectations, photo_path, description, report_id, storage_url FROM report_sessions WHERE user_jid = ?').get(sender) || session
        const summaryText = getReportSummaryText(currentSession)
        return await sendQueuedMessage(sock, sender, { text: summaryText })
    }

    // Procesamiento silencioso de votos en encuestas de WhatsApp
    if (rawMsg.pollUpdateMessage) {
        if (session.state === 'AWAITING_AFFECTATIONS_AND_DESC' || session.state === 'AWAITING_DESCRIPTION' || session.state === 'AWAITING_CONFIRMATION') {
            try {
                const pollUpdate = rawMsg.pollUpdateMessage
                const vote = pollUpdate.vote
                const pollCreationKey = pollUpdate.pollCreationMessageKey
                const pollMsgId = pollCreationKey?.id || session.poll_msg_id

                if (vote && pollMsgId) {
                    let pollEncKeyHex = session.poll_enc_key
                    let pollType = 'AFFECTATIONS'

                    if (global.pollRegistry && global.pollRegistry.has(pollMsgId)) {
                        const entry = global.pollRegistry.get(pollMsgId)
                        if (entry?.encKeyHex) pollEncKeyHex = entry.encKeyHex
                        if (entry?.type) pollType = entry.type
                    }

                    if (pollEncKeyHex) {
                        const pollEncKey = Buffer.from(pollEncKeyHex, 'hex')

                        // Generar candidatos exhaustivos para votante y bot (soportando LID y números normales)
                        const voterCandidates = new Set()
                        voterCandidates.add(sender)
                        voterCandidates.add(jidNormalizedUser(sender))
                        const [voterClean, voterServer] = (sender || '').split('@')
                        const voterRaw = (voterClean || '').split(':')[0]
                        if (voterServer && voterRaw) {
                            voterCandidates.add(`${voterRaw}@${voterServer}`)
                            voterCandidates.add(`${voterRaw}:0@${voterServer}`)
                        }
                        try {
                            const revPath = path.join(AUTH_DIR, `lid-mapping-${voterRaw}_reverse.json`)
                            if (fs.existsSync(revPath)) {
                                const pn = JSON.parse(fs.readFileSync(revPath, 'utf8'))
                                if (pn) {
                                    voterCandidates.add(`${pn}@s.whatsapp.net`)
                                    voterCandidates.add(`${pn}:0@s.whatsapp.net`)
                                }
                            }
                        } catch (_) { }

                        const voterAuthor = getKeyAuthor(msg.key, sock.user?.id)
                        if (voterAuthor) {
                            voterCandidates.add(voterAuthor)
                            voterCandidates.add(jidNormalizedUser(voterAuthor))
                        }
                        if (msg.key?.participant) {
                            voterCandidates.add(msg.key.participant)
                            voterCandidates.add(jidNormalizedUser(msg.key.participant))
                        }

                        const botCandidates = new Set()
                        if (sock.user?.id) {
                            botCandidates.add(sock.user.id)
                            botCandidates.add(jidNormalizedUser(sock.user.id))
                            const botRaw = sock.user.id.split('@')[0].split(':')[0]
                            botCandidates.add(`${botRaw}@s.whatsapp.net`)
                            botCandidates.add(`${botRaw}:0@s.whatsapp.net`)
                        }
                        if (sock.user?.lid) {
                            botCandidates.add(sock.user.lid)
                            botCandidates.add(jidNormalizedUser(sock.user.lid))
                            const botLidRaw = sock.user.lid.split('@')[0].split(':')[0]
                            botCandidates.add(`${botLidRaw}@lid`)
                            botCandidates.add(`${botLidRaw}:0@lid`)
                        }
                        const creatorFromKey = pollCreationKey?.participant || pollCreationKey?.remoteJid || ''
                        if (creatorFromKey) {
                            botCandidates.add(creatorFromKey)
                            botCandidates.add(jidNormalizedUser(creatorFromKey))
                        }

                        let decrypted = null
                        let lastDecryptError = null
                        for (const voterJid of voterCandidates) {
                            for (const pollCreatorJid of botCandidates) {
                                try {
                                    decrypted = decryptPollVote(vote, { pollCreatorJid, pollMsgId, pollEncKey, voterJid })
                                    if (decrypted?.selectedOptions) break
                                } catch (e) {
                                    lastDecryptError = e
                                }
                            }
                            if (decrypted?.selectedOptions) break
                        }

                        if (decrypted && decrypted.selectedOptions) {
                            const selectedHashes = decrypted.selectedOptions.map(opt => Buffer.from(opt).toString('hex'))

                            // 1. Si el voto corresponde a la encuesta interactiva de confirmación (Confirmar / Cancelar)
                            if (pollType === 'CONFIRMATION') {
                                const hashConfirm1 = crypto.createHash('sha256').update('1. Confirmar y enviar').digest('hex')
                                const hashConfirm2 = crypto.createHash('sha256').update('Confirmar y enviar').digest('hex')
                                const hashConfirm3 = crypto.createHash('sha256').update('1. Confirmar').digest('hex')
                                const hashConfirm4 = crypto.createHash('sha256').update('Confirmar').digest('hex')
                                const hashCancel1 = crypto.createHash('sha256').update('0. Cancelar').digest('hex')
                                const hashCancel2 = crypto.createHash('sha256').update('Cancelar').digest('hex')

                                if (selectedHashes.includes(hashConfirm1) || selectedHashes.includes(hashConfirm2) || selectedHashes.includes(hashConfirm3) || selectedHashes.includes(hashConfirm4)) {
                                    addLog('info', `✅ Opción 'Confirmar y enviar' seleccionada en encuesta interactiva por ${sender}`)
                                    return await executeReportConfirmation(sock, sender, session)
                                }

                                if (selectedHashes.includes(hashCancel1) || selectedHashes.includes(hashCancel2)) {
                                    addLog('info', `❌ Opción 'Cancelar' seleccionada en encuesta interactiva por ${sender}`)
                                    deleteSession(sender)
                                    const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
                                    await sendQueuedMessage(sock, sender, { text: cancelMsg })
                                    return true
                                }
                            }

                            // 3. Si el voto corresponde a la encuesta de afectaciones
                            const selectedCategories = []
                            AFFECTATION_CATEGORIES.forEach((cat, idx) => {
                                const optionText = `${idx + 1}. ${cat}`
                                const hash = crypto.createHash('sha256').update(optionText).digest('hex')
                                if (selectedHashes.includes(hash)) {
                                    selectedCategories.push(cat)
                                }
                            })

                            if (selectedCategories.length > 0 || pollType === 'AFFECTATIONS') {
                                db.prepare('UPDATE report_sessions SET selected_affectations = ?, updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?')
                                    .run(JSON.stringify(selectedCategories), sender)

                                addLog('info', `Afectaciones actualizadas desde encuesta para ${sender}: ${selectedCategories.join(', ')}`)
                                await updateSavedReportData(sender)
                            }
                        } else {
                            addLog('warn', `No se pudo descifrar voto de encuesta para ${sender}: ${lastDecryptError?.message || 'Sin opciones'}`)
                        }
                    }
                }
            } catch (err) {
                addLog('error', `Error al descifrar voto de encuesta: ${err.message}`)
            }
        }
        return true
    }

    // 2. Estado: AWAITING_LOCATION (Ubicación GPS obligatoria: nativa o Google Maps)
    if (session.state === 'AWAITING_LOCATION') {
        let lat = null
        let lng = null

        const locationObj = rawMsg.locationMessage || rawMsg.liveLocationMessage

        if (locationObj && typeof locationObj.degreesLatitude === 'number' && typeof locationObj.degreesLongitude === 'number') {
            lat = locationObj.degreesLatitude
            lng = locationObj.degreesLongitude
        } else if (text.length > 0 && extractGoogleMapsUrlFromText(text)) {
            const coords = await extractCoordinatesFromGoogleMaps(text, customDependencies?.fetch)
            if (coords) {
                lat = coords.lat
                lng = coords.lng
            } else {
                const invalidLinkMsg = `⚠️ No pudimos obtener una ubicación precisa de ese enlace de Google Maps.\n\nPor favor, compartí tu ubicación directamente usando la opción de WhatsApp (📎 > Ubicación).\n\nPara cancelar el reporte, escribí *0*.`
                db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
                await sendQueuedMessage(sock, sender, { text: invalidLinkMsg })
                return true
            }
        }

        if (lat !== null && lng !== null && isValidCoordinate(lat, lng)) {
            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_PHOTO',
                    latitude = ?,
                    longitude = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(lat, lng, sender)

            const confirmMsg = `✅ ¡Ubicación recibida con éxito! 📍\nCoordenadas: ${lat.toFixed(6)}, ${lng.toFixed(6)}\n\n📸 *Fotografía del incidente*\n\nPor favor enviá una fotografía del lugar como evidencia para continuar.\n\nPara cancelar el reporte, escribí *0*.`

            await sendQueuedMessage(sock, sender, { text: confirmMsg })
            addLog('message_out', `Ubicación GPS guardada (${lat}, ${lng}) para ${sender}`)
            return true
        }

        const helpMsg = `Para continuar, compartí la ubicación del lugar afectado.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sendQueuedMessage(sock, sender, { text: helpMsg })
        return true
    }

    // 3. Estado: AWAITING_PHOTO (Fotografía obligatoria)
    if (session.state === 'AWAITING_PHOTO') {
        const imageMessage = rawMsg.imageMessage

        if (imageMessage) {
            try {
                addLog('info', `Descargando fotografía de evidencia enviada por ${sender}...`)
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                    logger: pino({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage
                })

                const sanitizedJid = sender.replace(/[^a-zA-Z0-9]/g, '_')
                const filename = `photo_${sanitizedJid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`
                const filePath = path.join(UPLOADS_DIR, filename)

                fs.writeFileSync(filePath, buffer)

                // Persistencia Progresiva Temprana: Ubicación y fotografía ya son válidas.
                // Generar UUID de inmediato y auto-guardar en cola y Supabase sin esperar confirmación final.
                const reportId = crypto.randomUUID()

                db.prepare(`
                    UPDATE report_sessions
                    SET state = 'AWAITING_DESCRIPTION',
                        photo_path = ?,
                        report_id = ?,
                        storage_url = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_jid = ?
                `).run(filePath, reportId, sender)

                addLog('info', `Fotografía guardada localmente en ${filePath}. Reporte auto-guardado: ${reportId}`)

                // Guardar automáticamente en pending_sync_reports
                try {
                    db.prepare(`
                        INSERT INTO pending_sync_reports (
                            id, user_jid, latitude, longitude, selected_affectations, photo_path, description, storage_url, status, attempts, next_retry_at, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, '[]', ?, 'Sin descripción', NULL, 'PENDING', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    `).run(
                        reportId,
                        sender,
                        session.latitude,
                        session.longitude,
                        filePath
                    )
                    addLog('info', `Reporte básico ${reportId} encolado para sincronización inmediata con Supabase.`)
                } catch (queueErr) {
                    addLog('error', `Error al encolar reporte básico ${reportId}: ${queueErr.message}`)
                }

                // Disparar sincronización asíncrona de inmediato (no bloquea al usuario)
                triggerSyncPendingReports().catch(syncErr => {
                    addLog('error', `⚠️ Error al activar sincronización temprana: ${syncErr.message}`)
                })

                await sendAffectationPoll(sock, sender)
                return true

            } catch (err) {
                addLog('error', `Error al descargar fotografía: ${err.message}`)
                const errorMsg = `No pudimos procesar la imagen. Por favor intentá enviarla nuevamente.`
                await sendQueuedMessage(sock, sender, { text: errorMsg })
                return true
            }
        }

        const helpMsg = `Necesitamos una fotografía del lugar para continuar.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sendQueuedMessage(sock, sender, { text: helpMsg })
        return true
    }

    // 4. Estado: AWAITING_AFFECTATIONS_AND_DESC (Compatibilidad con sesiones existentes)
    if (session.state === 'AWAITING_AFFECTATIONS_AND_DESC') {
        if (text === '0' || lowerText === 'cancelar' || lowerText === 'salir') {
            await sendReportSummary()
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Salida de preguntas opcionales por usuario: ${sender}. Reporte ${session.report_id} conservado.`)
            return true
        }

        if (text === '1' || lowerText === 'omitir' || lowerText === 'listo' || lowerText === 'continuar') {
            await updateSavedReportData(sender)
            await sendReportSummary()
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Reporte completado (sin descripción) por ${sender}. Sesión cerrada.`)
            return true
        }

        if (text.length > 0) {
            db.prepare(`
                UPDATE report_sessions
                SET description = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(text, sender)

            addLog('info', `Descripción guardada para ${sender}: ${text}`)
            await updateSavedReportData(sender)
            await sendReportSummary()
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Reporte completado con descripción por ${sender}. Sesión cerrada.`)
            return true
        }

        const helpDesc = `✍️ *Descripción del incidente (opcional)*\n\n¿Querés agregar algún detalle sobre lo ocurrido?\n\n👉 Escribí tu descripción o respondé *1* para omitir.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sendQueuedMessage(sock, sender, { text: helpDesc })
        return true
    }

    // 5. Estado: AWAITING_DESCRIPTION (Descripción opcional del incidente)
    if (session.state === 'AWAITING_DESCRIPTION') {
        if (text === '0' || lowerText === 'cancelar' || lowerText === 'salir') {
            await sendReportSummary()
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Salida de preguntas opcionales por usuario: ${sender}. Reporte ${session.report_id} conservado.`)
            return true
        }

        if (text === '1' || lowerText === 'omitir' || lowerText === 'listo' || lowerText === 'continuar') {
            await updateSavedReportData(sender)
            await sendReportSummary()
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Reporte completado (sin descripción) por ${sender}. Sesión cerrada.`)
            return true
        }

        if (text.length > 0) {
            db.prepare(`
                UPDATE report_sessions
                SET description = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(text, sender)

            addLog('info', `Descripción guardada para ${sender}: ${text}`)
            await updateSavedReportData(sender)
            await sendReportSummary()
            await sendQueuedMessage(sock, sender, { text: FINAL_SUCCESS_MESSAGE })
            deleteSessionWithoutPhoto(sender)
            addLog('message_out', `Reporte completado con descripción por ${sender}. Sesión cerrada.`)
            return true
        }

        const helpDesc = `✍️ *Descripción del incidente (opcional)*\n\n¿Querés agregar algún detalle sobre lo ocurrido?\n\n👉 Escribí tu descripción o respondé *1* para omitir.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sendQueuedMessage(sock, sender, { text: helpDesc })
        return true
    }

    // 6. Estado: AWAITING_CONFIRMATION (Confirmación final y envío a Supabase)
    if (session.state === 'AWAITING_CONFIRMATION') {
        if (text === '1' || lowerText === 'confirmar') {
            return await executeReportConfirmation(sock, sender, session)
        }

        if (text === '0' || lowerText === 'cancelar') {
            deleteSession(sender)
            const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
            await sendQueuedMessage(sock, sender, { text: cancelMsg })
            return true
        }

        const reConfirmMsg = `Para finalizar, respondé *1* o *CONFIRMAR* para enviar el reporte, o *0* o *CANCELAR* para descartarlo.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sendQueuedMessage(sock, sender, { text: reConfirmMsg })
        return true
    }

    return false
}

// Conexión principal con Baileys
async function connectToWhatsApp() {
    console.log('🔄 Iniciando FloodBot con Baileys...')

    // Mantenimiento de arranque: purga silenciosa de sesiones expiradas y archivos huérfanos
    cleanupExpiredSessionsAndFiles()

    // Sincronizar reportes pendientes que hayan quedado de sesiones anteriores
    triggerSyncPendingReports().catch(e => addLog('error', `Error al sincronizar reportes pendientes en arranque: ${e.message}`))

    // Programar limpieza periódica cada 1 minuto en segundo plano (revisa sesiones con >15 min de inactividad)
    if (!global.cleanupInterval) {
        global.cleanupInterval = setInterval(() => {
            cleanupExpiredSessionsAndFiles().catch(e => addLog('error', `Error en intervalo de limpieza: ${e.message}`))
        }, 60 * 1000)
    }

    // Programar reintento periódico de reportes pendientes cada 30 segundos
    if (!global.syncInterval) {
        global.syncInterval = setInterval(() => {
            triggerSyncPendingReports().catch(e => addLog('error', `Error en intervalo de sincronización: ${e.message}`))
        }, 30 * 1000)
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'silent' })
    })

    // Asignar el socket activo a la cola de salida y referencia global
    defaultQueue.setSocket(sock)
    global.activeSock = sock

    // Vinculación segura por consola si el número no está registrado aún
    if (!state.creds.registered) {
        console.log('\n======================================================')
        console.log('📱 WHATSAPP NO ESTÁ VINCULADO')
        console.log('======================================================')
        const phoneNumber = await askQuestion('👉 Ingresá tu número con código de país (ej: 54911xxxxxxxx): ')
        const cleanNumber = phoneNumber.replace(/\D/g, '')

        if (cleanNumber) {
            setTimeout(async () => {
                try {
                    const pairingCode = await sock.requestPairingCode(cleanNumber)
                    console.log('\n======================================================')
                    console.log(`🔑 CÓDIGO DE VINCULACIÓN: ${pairingCode}`)
                    console.log('👉 Abrí WhatsApp en tu celular:')
                    console.log('   Dispositivos vinculados > Vincular dispositivo > Vincular con número')
                    console.log('======================================================\n')
                } catch (err) {
                    console.error('❌ Error al solicitar código de vinculación:', err.message)
                }
            }, 3000)
        }
    }

    // Eventos de estado de conexión
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
            defaultQueue.pause()

            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : lastDisconnect?.error?.statusCode || 'unknown'
            const errorReason = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'Sin detalle')

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log(`⚠️ Conexión cerrada (Código: ${statusCode}, Motivo: ${errorReason})`)

            if (shouldReconnect) {
                console.log('🔄 Reconectando en 5 segundos...')
                setTimeout(connectToWhatsApp, 5000)
            } else {
                console.log('⚠️ La sesión fue cerrada por WhatsApp o requiere reautenticación.')
                console.log('ℹ️ No se eliminan credenciales locales automáticamente.')
            }
        } else if (connection === 'connecting') {
            console.log('⏳ Conectando con los servidores de WhatsApp...')
        } else if (connection === 'open') {
            defaultQueue.setSocket(sock)
            defaultQueue.resume()

            const botNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || 'Desconocido'
            console.log('\n======================================================')
            console.log(`✅ WHATSAPP CONECTADO EXITOSAMENTE`)
            console.log(`📞 Número de Bot: +${botNumber}`)
            if (isSupabaseConfigured()) {
                console.log(`☁️ Supabase Cloud Storage & DB: HABILITADO`)
            } else {
                console.log(`⚠️ Supabase: NO CONFIGURADO en .env`)
            }
            console.log('🤖 FloodBot listo para recibir reportes de ciudadanos.')
            console.log('======================================================\n')
        }
    })

    // Guardado automático de credenciales actualizadas
    sock.ev.on('creds.update', saveCreds)

    // Manejador de mensajes entrantes y eventos de sincronización
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Ignorar eventos que no sean notificaciones en vivo
        if (type !== 'notify' && type !== 'append') return

        const nowSec = Math.floor(Date.now() / 1000)

        for (const msg of messages) {
            if (!msg.message) continue

            const sender = msg.key.remoteJid
            // Solo procesar mensajes de usuarios individuales (ignorar grupos, broadcast y canales)
            if (sender.endsWith('@g.us') || sender.endsWith('@broadcast') || sender.endsWith('@newsletter')) continue

            // Protección contra mensajes antiguos encolados o duplicados durante reconexión
            // Si el mensaje tiene más de 5 minutos de antigüedad respecto a la hora actual, se descarta
            const msgTimestamp = Number(msg.messageTimestamp || 0)
            if (msgTimestamp > 0 && (nowSec - msgTimestamp) > 300) {
                continue
            }

            // Deduplicación por ID de mensaje para evitar procesar dos veces el mismo mensaje
            if (!global.processedMsgIds) global.processedMsgIds = new Set()
            const msgId = msg.key?.id
            if (msgId) {
                if (global.processedMsgIds.has(msgId)) continue
                global.processedMsgIds.add(msgId)
                if (global.processedMsgIds.size > 500) {
                    const firstItem = global.processedMsgIds.values().next().value
                    global.processedMsgIds.delete(firstItem)
                }
            }

            await handleFloodReportFlow(sock, sender, msg)
        }
    })

    return sock
}

function closeDatabase() {
    try {
        db.close()
    } catch (_) { }
}

// Exportación para suite de pruebas
if (process.env.NODE_ENV === 'test') {
    module.exports = {
        db,
        closeDatabase,
        FINAL_SUCCESS_MESSAGE,
        SESSION_TIMEOUT_MS,
        parseSessionUtcTimestamp,
        isSessionExpired,
        safeDeleteUploadFile,
        deleteSession,
        deleteSessionWithoutPhoto,
        cleanupExpiredSessionsAndFiles,
        getNextRetryDelayMs,
        processSinglePendingReport,
        triggerSyncPendingReports,
        updateSavedReportData,
        handleFloodReportFlow,
        AFFECTATION_CATEGORIES,
        UPLOADS_DIR,
        DB_PATH,
        CONFIRMATION_INTERFACE_MODE,
        sendReportConfirmationInterface,
        executeReportConfirmation,
        sendAffectationPoll,
        getReportSummaryText,
        defaultQueue,
        sendQueuedMessage,
        isValidCoordinate,
        isAllowedGoogleMapsHost,
        extractGoogleMapsUrlFromText,
        extractCoordinatesFromResolvedUrl,
        resolveGoogleMapsUrl,
        extractCoordinatesFromGoogleMaps,
        recordBotOutgoingMessageId,
        isBotOutgoingMessageId,
        isAdvisorClosingMessage,
        getAdvisorSession,
        activateAdvisorSession,
        closeAdvisorSession,
        clearAdvisorSession,
        handleAdvisorOutgoingMessage,
        touchAdvisorSessionActivity,
        isAdvisorSessionExpired,
        ADVISOR_ACTIVE_TIMEOUT_MS,
        DECISION_INTERFACE_MODE: null,
        sendContinueOrCancelInterface: null,
        EXPERIMENTAL_BUTTONS_ENABLED: false,
        sendContinueOrCancelButtons: null
    }
}

// Iniciar bot solo en ejecución directa y fuera de pruebas
if (require.main === module && process.env.NODE_ENV !== 'test') {
    connectToWhatsApp().catch(err => {
        console.error('❌ Error crítico al arrancar FloodBot:', err)
    })
}
