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
    generateWAMessageFromContent
} = require('@whiskeysockets/baileys')

const {
    uploadReportPhoto,
    insertReportRecord,
    syncReportToSupabase,
    isSupabaseConfigured
} = require('./supabaseClient')

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

// Tiempo máximo de inactividad por usuario (30 minutos en milisegundos)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000

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
`)

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

// Elimina la sesión en SQLite y su foto temporal asociada (si existe) de forma segura
function deleteSession(userJid) {
    try {
        const current = db.prepare('SELECT photo_path FROM report_sessions WHERE user_jid = ?').get(userJid)
        if (current?.photo_path) {
            safeDeleteUploadFile(current.photo_path)
        }
        db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(userJid)
    } catch (err) {
        addLog('error', `Error al eliminar sesión de ${userJid}: ${err.message}`)
    }
}

// Limpieza periódica y al inicio: elimina sesiones expiradas (>30 min) y fotos huérfanas en uploads/
function cleanupExpiredSessionsAndFiles() {
    try {
        const activePhotoPaths = new Set()
        let expiredCount = 0

        // 1. Sesiones de conversación activas
        const allSessions = db.prepare('SELECT user_jid, photo_path, updated_at FROM report_sessions').all()
        for (const s of allSessions) {
            if (isSessionExpired(s)) {
                if (s.photo_path) {
                    safeDeleteUploadFile(s.photo_path)
                }
                db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(s.user_jid)
                expiredCount++
            } else if (s.photo_path) {
                // Sesión activa: registrar su fotografía para que NUNCA sea eliminada
                try {
                    activePhotoPaths.add(path.resolve(s.photo_path))
                } catch (_) {}
            }
        }

        if (expiredCount > 0) {
            addLog('info', `🧹 Limpieza: ${expiredCount} sesión(es) expirada(s) eliminada(s) por inactividad.`)
        }

        // 2. Reportes confirmados pendientes de sincronización (NUNCA deben eliminarse sus fotos)
        try {
            const pendingReports = db.prepare('SELECT photo_path FROM pending_sync_reports WHERE photo_path IS NOT NULL').all()
            for (const p of pendingReports) {
                if (p.photo_path) {
                    activePhotoPaths.add(path.resolve(p.photo_path))
                }
            }
        } catch (_) {}

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
                        // Si está huérfana y tiene más de 30 minutos de antigüedad (margen de seguridad)
                        if (now - stat.mtimeMs >= SESSION_TIMEOUT_MS) {
                            safeDeleteUploadFile(fullPath)
                        }
                    } catch (_) {}
                }
            }
        }
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
    const isConfiguredFn = customSyncDependencies?.isSupabaseConfigured || isSupabaseConfigured

    if (!isConfiguredFn()) {
        addLog('warn', `Supabase no está configurado. El reporte pendiente ${report.id} continuará en espera.`)
        return { success: false, error: 'Supabase no configurado' }
    }

    try {
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
        } catch (_) {}
        addLog('error', `⚠️ Excepción procesando sincronización de reporte ${report.id}: ${err.message}`)
        return { success: false, error: err.message }
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
            WHERE status = 'PENDING' AND next_retry_at <= ?
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

// Envío de interfaz de confirmación de reporte (resumen + encuesta táctil o texto clásico)
async function sendReportConfirmationInterface(sock, sender, currentSession, modeOverride = null) {
    const mode = modeOverride || CONFIRMATION_INTERFACE_MODE

    let affectationsList = []
    try {
        if (currentSession?.selected_affectations) {
            affectationsList = JSON.parse(currentSession.selected_affectations)
        }
    } catch (_) { }

    const affectationsStr = affectationsList.length > 0
        ? affectationsList.join(', ')
        : 'Ninguna'

    const descStr = currentSession?.description && currentSession.description.trim().length > 0
        ? currentSession.description.trim()
        : 'No proporcionada'

    const coordsStr = (currentSession?.latitude != null && currentSession?.longitude != null)
        ? `${currentSession.latitude.toFixed(6)}, ${currentSession.longitude.toFixed(6)}`
        : 'No registrada'

    const summaryText = `📋 *Resumen de tu reporte*\n\n` +
        `📍 *Ubicación:* ${coordsStr}\n` +
        `📸 *Fotografía:* Recibida ✅\n` +
        `⛈️ *Afectaciones:* ${affectationsStr}\n` +
        `✍️ *Descripción:* ${descStr}`

    if (mode === 'POLL') {
        try {
            await sock.sendMessage(sender, { text: summaryText })

            const confirmPollMsg = await sock.sendMessage(sender, {
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

    const sent = await sock.sendMessage(sender, { text: classicSummary })
    addLog('message_out', `Resumen de reporte enviado para confirmación (modo texto clásico) a ${sender}`)
    return sent
}

// Ejecución segura de confirmación de reporte y registro en cola local de sincronización
async function executeReportConfirmation(sock, sender, session) {
    const confirmedSession = db.prepare('SELECT latitude, longitude, selected_affectations, photo_path, description FROM report_sessions WHERE user_jid = ?').get(sender) || session

    // Validar coordenadas obligatorias
    if (confirmedSession.latitude == null || confirmedSession.longitude == null) {
        const invalidCoordsMsg = `No se detectaron coordenadas válidas para este reporte. Escribí *REPORTAR* para iniciar un reporte nuevo.`
        deleteSession(sender)
        await sock.sendMessage(sender, { text: invalidCoordsMsg })
        return true
    }

    const reportId = crypto.randomUUID()

    // 1. Guardar primero en pending_sync_reports
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
            confirmedSession.description || null
        )
    } catch (err) {
        addLog('error', `Fallo al registrar reporte en pending_sync_reports para ${sender}: ${err.message}`)
        const dbFailMsg = `⚠️ Ocurrió un error al registrar tu reporte localmente. Por favor respondé *1* para intentar confirmar nuevamente.`
        await sock.sendMessage(sender, { text: dbFailMsg })
        return true
    }

    // 2. Solo tras guardar exitosamente en SQLite, cerrar la sesión conversacional SIN borrar la foto
    deleteSessionWithoutPhoto(sender)

    // 3. Enviar confirmación al usuario
    const finalMsg = `✅ *¡Reporte recibido correctamente!*\n\n¡Muchas gracias por tu colaboración! 🙌\n\nTu reporte contribuirá al monitoreo de inundaciones urbanas y a la identificación de zonas afectadas.\n\n🗺️ *¡Explorá nuestro mapa interactivo!*\n\nPodés visualizar los reportes de inundaciones en nuestra plataforma web:\n\n🔗 https://mapa-chi-steel.vercel.app/`
    await sock.sendMessage(sender, { text: finalMsg })
    addLog('message_out', `Reporte confirmado por ${sender} (ID pendiente: ${reportId}). Sesión cerrada.`)

    // 4. Disparar sincronización asíncrona hacia Supabase (no bloquea al usuario)
    triggerSyncPendingReports().catch(syncErr => {
        addLog('error', `⚠️ Error al activar sincronización asíncrona: ${syncErr.message}`)
    })

    return true
}

// Envío de encuesta interactiva de WhatsApp para afectaciones y solicitud directa de descripción
async function sendAffectationPoll(sock, sender) {
    let pollMsgId = null
    let pollEncKeyHex = null

    try {
        const sentMsg = await sock.sendMessage(sender, {
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
    await sock.sendMessage(sender, { text: descPrompt })
    addLog('message_out', `Solicitud de descripción enviada a ${sender}`)
}

// Control del flujo conversacional para el reporte de inundaciones
async function handleFloodReportFlow(sock, sender, msg) {
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
        } catch (_) {}
    }

    const text = messageContent.trim()
    const lowerText = text.toLowerCase()

    // Debounce para evitar ráfagas repetidas
    if (!global.recentTriggers) global.recentTriggers = new Map()

    const session = db.prepare('SELECT state, latitude, longitude, selected_affectations, photo_path, description, poll_msg_id, poll_enc_key, updated_at FROM report_sessions WHERE user_jid = ?').get(sender)

    // Helper para iniciar un reporte nuevo
    const startNewReport = async () => {
        const lastTrigger = global.recentTriggers.get(sender) || 0
        const now = Date.now()
        if (now - lastTrigger < 3000) return true
        global.recentTriggers.set(sender, now)

        // Limpieza de foto temporal anterior si existía en una sesión previa no confirmada
        const prevSession = db.prepare('SELECT photo_path FROM report_sessions WHERE user_jid = ?').get(sender)
        if (prevSession?.photo_path) {
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
                updated_at = CURRENT_TIMESTAMP
        `).run(sender)

        const welcomeMsg = `⛈️ *Sistema de Monitoreo de Inundaciones Urbanas* ⛈️\n\n¡Hola! 👋\n\nEste sistema busca recopilar información sobre inundaciones urbanas mediante la participación ciudadana. Tu reporte ayudará a identificar las zonas afectadas y mejorar el conocimiento sobre estos eventos.\n\nPara registrar tu reporte, te pediremos la siguiente información:\n\n📍 *Ubicación:* lugar donde ocurre la inundación.\n\n📸 *Fotografía:* imagen del lugar afectado.\n\n⛈️ *Afectaciones:* situaciones o daños observados.\n\n✍️ *Descripción (opcional):* información adicional sobre lo ocurrido.\n\nTu participación nos ayuda a identificar y conocer mejor las zonas afectadas por inundaciones.`

        const locationPrompt = `📍 *Paso 1: Ubicación*\n\nPor favor, compartí la ubicación del lugar donde está ocurriendo la inundación.\n\nPodés enviar tu ubicación actual o seleccionar otro punto en el mapa.`

        await sock.sendMessage(sender, { text: welcomeMsg })
        await sock.sendMessage(sender, { text: locationPrompt })
        addLog('message_out', `Bienvenida y solicitud de ubicación enviadas a ${sender}`)
        return true
    }

    // Comandos de reinicio manual (Inicio / Reiniciar / Empezar)
    const isRestartCommand = lowerText === 'inicio' || lowerText === 'reiniciar' || lowerText === 'empezar'

    // Comandos de cancelación manual (Cancelar / 0)
    const isCancelCommand = lowerText === 'cancelar' || text === '0'

    // 1. Cancelación global en cualquier momento
    if (isCancelCommand) {
        deleteSession(sender)
        const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
        await sock.sendMessage(sender, { text: cancelMsg })
        addLog('message_out', `Flujo cancelado por usuario: ${sender}`)
        return true
    }

    // 2. Reinicio manual en cualquier momento
    if (isRestartCommand) {
        deleteSession(sender)
        addLog('info', `Reinicio solicitado por usuario (${text}) para ${sender}`)
        return await startNewReport()
    }

    // Iniciar con comando explícito
    if (lowerText === 'reportar' || lowerText.includes('inundacion') || lowerText.includes('inundación')) {
        return await startNewReport()
    }

    // Si no hay sesión previa, iniciar con el primer mensaje
    if (!session) {
        return await startNewReport()
    }

    // 3. Expiración por inactividad de 30 minutos:
    // Si pasaron 30 min o más desde la última interacción en UTC, se descarta silenciosamente
    // la sesión previa (sin mensajes automáticos de expiración) y se reinicia desde la bienvenida.
    if (isSessionExpired(session)) {
        addLog('info', `Sesión expirada por inactividad (>30 min) para ${sender}. Reiniciando flujo.`)
        deleteSession(sender)
        return await startNewReport()
    }

    // Helper para mostrar resumen antes de confirmar
    const sendReportSummary = async () => {
        const currentSession = db.prepare('SELECT latitude, longitude, selected_affectations, photo_path, description FROM report_sessions WHERE user_jid = ?').get(sender)
        return await sendReportConfirmationInterface(sock, sender, currentSession)
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
                        } catch (_) {}

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
                                    await sock.sendMessage(sender, { text: cancelMsg })
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

    // 2. Estado: AWAITING_LOCATION (Ubicación GPS obligatoria)
    if (session.state === 'AWAITING_LOCATION') {
        const locationObj = rawMsg.locationMessage || rawMsg.liveLocationMessage

        if (locationObj && typeof locationObj.degreesLatitude === 'number' && typeof locationObj.degreesLongitude === 'number') {
            const lat = locationObj.degreesLatitude
            const lng = locationObj.degreesLongitude

            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_PHOTO',
                    latitude = ?,
                    longitude = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(lat, lng, sender)

            const confirmMsg = `✅ ¡Ubicación recibida con éxito! 📍\nCoordenadas: ${lat.toFixed(6)}, ${lng.toFixed(6)}\n\n📸 *Fotografía del incidente*\n\nPor favor enviá una fotografía del lugar como evidencia para continuar.`

            await sock.sendMessage(sender, { text: confirmMsg })
            addLog('message_out', `Ubicación GPS guardada (${lat}, ${lng}) para ${sender}`)
            return true
        }

        const helpMsg = `Para continuar, compartí la ubicación del lugar afectado.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sock.sendMessage(sender, { text: helpMsg })
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

                db.prepare(`
                    UPDATE report_sessions
                    SET state = 'AWAITING_DESCRIPTION',
                        photo_path = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_jid = ?
                `).run(filePath, sender)

                addLog('info', `Fotografía guardada localmente en ${filePath}`)
                await sendAffectationPoll(sock, sender)
                return true

            } catch (err) {
                addLog('error', `Error al descargar fotografía: ${err.message}`)
                const errorMsg = `No pudimos procesar la imagen. Por favor intentá enviarla nuevamente.`
                await sock.sendMessage(sender, { text: errorMsg })
                return true
            }
        }

        const helpMsg = `Necesitamos una fotografía del lugar para continuar.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sock.sendMessage(sender, { text: helpMsg })
        return true
    }

    // 4. Estado: AWAITING_AFFECTATIONS_AND_DESC (Compatibilidad con sesiones existentes)
    if (session.state === 'AWAITING_AFFECTATIONS_AND_DESC') {
        if (text === '0' || lowerText === 'cancelar') {
            deleteSession(sender)
            const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
            await sock.sendMessage(sender, { text: cancelMsg })
            return true
        }

        if (text === '1' || lowerText === 'omitir' || lowerText === 'listo' || lowerText === 'continuar') {
            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_CONFIRMATION',
                    description = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(sender)

            await sendReportSummary()
            return true
        }

        if (text.length > 0) {
            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_CONFIRMATION',
                    description = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(text, sender)

            addLog('info', `Descripción guardada para ${sender}: ${text}`)
            await sendReportSummary()
            return true
        }

        const helpDesc = `✍️ *Descripción del incidente (opcional)*\n\n¿Querés agregar algún detalle sobre lo ocurrido?\n\n👉 Escribí tu descripción o respondé *1* para omitir.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sock.sendMessage(sender, { text: helpDesc })
        return true
    }

    // 5. Estado: AWAITING_DESCRIPTION (Descripción opcional del incidente)
    if (session.state === 'AWAITING_DESCRIPTION') {
        if (text === '0' || lowerText === 'cancelar') {
            deleteSession(sender)
            const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
            await sock.sendMessage(sender, { text: cancelMsg })
            return true
        }

        if (text === '1' || lowerText === 'omitir' || lowerText === 'listo' || lowerText === 'continuar') {
            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_CONFIRMATION',
                    description = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(sender)

            await sendReportSummary()
            return true
        }

        if (text.length > 0) {
            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_CONFIRMATION',
                    description = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(text, sender)

            addLog('info', `Descripción guardada para ${sender}: ${text}`)
            await sendReportSummary()
            return true
        }

        const helpDesc = `✍️ *Descripción del incidente (opcional)*\n\n¿Querés agregar algún detalle sobre lo ocurrido?\n\n👉 Escribí tu descripción o respondé *1* para omitir.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sock.sendMessage(sender, { text: helpDesc })
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
            await sock.sendMessage(sender, { text: cancelMsg })
            return true
        }

        const reConfirmMsg = `Para finalizar, respondé *1* o *CONFIRMAR* para enviar el reporte, o *0* o *CANCELAR* para descartarlo.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sock.sendMessage(sender, { text: reConfirmMsg })
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

    // Programar limpieza periódica cada 15 minutos en segundo plano (sin mensajes a usuarios)
    if (!global.cleanupInterval) {
        global.cleanupInterval = setInterval(cleanupExpiredSessionsAndFiles, 15 * 60 * 1000)
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

    // Manejador de mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Ignorar eventos que no sean notificaciones de mensajes entrantes en vivo
        if (type !== 'notify') return

        const nowSec = Math.floor(Date.now() / 1000)

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue

            const sender = msg.key.remoteJid
            // Solo procesar mensajes de usuarios individuales (ignorar grupos y broadcast)
            if (sender.endsWith('@g.us') || sender.endsWith('@broadcast')) continue

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
    } catch (_) {}
}

// Exportación para suite de pruebas
if (process.env.NODE_ENV === 'test') {
    module.exports = {
        db,
        closeDatabase,
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
        handleFloodReportFlow,
        AFFECTATION_CATEGORIES,
        UPLOADS_DIR,
        DB_PATH,
        CONFIRMATION_INTERFACE_MODE,
        sendReportConfirmationInterface,
        executeReportConfirmation,
        sendAffectationPoll,
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
