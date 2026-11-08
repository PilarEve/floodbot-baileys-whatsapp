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
    getKeyAuthor
} = require('@whiskeysockets/baileys')

const { syncReportToSupabase, isSupabaseConfigured } = require('./supabaseClient')

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

// Directorios y persistencia local
const AUTH_DIR = path.resolve(__dirname, 'auth_info_baileys')
const UPLOADS_DIR = path.resolve(__dirname, 'uploads')
const DB_PATH = path.resolve(__dirname, 'sessions.db')

// Tiempo máximo de inactividad por usuario (30 minutos en milisegundos)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

// Inicialización de SQLite para gestión de estados conversacionales
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
        const resolvedPath = path.resolve(filePath)
        const resolvedUploads = path.resolve(UPLOADS_DIR)
        // Seguridad: verificar que la ruta resuelta esté estrictamente dentro de uploads/
        if (!resolvedPath.startsWith(resolvedUploads) || resolvedPath === resolvedUploads) {
            addLog('warn', `Intento de eliminación fuera de uploads/ rechazado: ${resolvedPath}`)
            return false
        }
        if (fs.existsSync(resolvedPath)) {
            fs.unlinkSync(resolvedPath)
            addLog('info', `🧹 Archivo temporal eliminado con seguridad: ${path.basename(resolvedPath)}`)
            return true
        }
    } catch (err) {
        // Envoltorio seguro: nunca lanzar excepción ni detener el flujo del bot
        addLog('error', `Error controlado al intentar eliminar ${filePath}: ${err.message}`)
    }
    return false
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
        const allSessions = db.prepare('SELECT user_jid, photo_path, updated_at FROM report_sessions').all()
        const activePhotoPaths = new Set()
        let expiredCount = 0

        for (const s of allSessions) {
            if (isSessionExpired(s)) {
                if (s.photo_path) {
                    safeDeleteUploadFile(s.photo_path)
                }
                db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(s.user_jid)
                expiredCount++
            } else if (s.photo_path) {
                // Sesión activa: registrar su fotografía para que NUNCA sea eliminada
                activePhotoPaths.add(path.resolve(s.photo_path))
            }
        }

        if (expiredCount > 0) {
            addLog('info', `🧹 Limpieza: ${expiredCount} sesión(es) expirada(s) eliminada(s) por inactividad.`)
        }

        // Inspeccionar archivos en uploads/
        if (fs.existsSync(UPLOADS_DIR)) {
            const files = fs.readdirSync(UPLOADS_DIR)
            const now = Date.now()

            for (const file of files) {
                const fullPath = path.resolve(UPLOADS_DIR, file)
                // CONDICIÓN ESTRICTA: Solo eliminar si NO pertenece a una sesión activa
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

// Envío de encuesta interactiva de WhatsApp para afectaciones
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

    if (pollMsgId || pollEncKeyHex) {
        db.prepare(`
            UPDATE report_sessions
            SET poll_msg_id = ?,
                poll_enc_key = ?
            WHERE user_jid = ?
        `).run(pollMsgId, pollEncKeyHex, sender)
    }

    const pollInstruction = `👉 Respondé *1* o *LISTO* para continuar.\n👉 Respondé *0* o *CANCELAR* para salir.`

    await sock.sendMessage(sender, { text: pollInstruction })
    addLog('message_out', `Encuesta e instrucciones enviadas a ${sender}`)
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

        let affectationsList = []
        try {
            affectationsList = JSON.parse(currentSession?.selected_affectations || '[]')
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

        const summaryMsg = `📋 *Resumen de tu reporte*\n\n` +
            `📍 *Ubicación:* ${coordsStr}\n` +
            `📸 *Fotografía:* Recibida ✅\n` +
            `⛈️ *Afectaciones:* ${affectationsStr}\n` +
            `✍️ *Descripción:* ${descStr}\n\n` +
            `¿Confirmás que los datos son correctos?\n\n` +
            `👉 Respondé *1* o *CONFIRMAR* para enviar.\n` +
            `👉 Respondé *0* o *CANCELAR* para salir.`

        await sock.sendMessage(sender, { text: summaryMsg })
        addLog('message_out', `Resumen de reporte enviado para confirmación a ${sender}`)
    }

    // Procesamiento silencioso de votos en encuestas de WhatsApp
    if (rawMsg.pollUpdateMessage) {
        if (session.state === 'AWAITING_AFFECTATIONS_AND_DESC' || session.state === 'AWAITING_DESCRIPTION') {
            try {
                const pollUpdate = rawMsg.pollUpdateMessage
                const vote = pollUpdate.vote
                const pollCreationKey = pollUpdate.pollCreationMessageKey
                const pollMsgId = pollCreationKey?.id || session.poll_msg_id

                if (vote && session.poll_enc_key && pollMsgId) {
                    const pollEncKey = Buffer.from(session.poll_enc_key, 'hex')

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
                        const selectedCategories = []
                        AFFECTATION_CATEGORIES.forEach((cat, idx) => {
                            const optionText = `${idx + 1}. ${cat}`
                            const hash = crypto.createHash('sha256').update(optionText).digest('hex')
                            if (selectedHashes.includes(hash)) {
                                selectedCategories.push(cat)
                            }
                        })

                        db.prepare('UPDATE report_sessions SET selected_affectations = ?, updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?')
                            .run(JSON.stringify(selectedCategories), sender)

                        addLog('info', `Afectaciones actualizadas desde encuesta para ${sender}: ${selectedCategories.join(', ')}`)
                    } else {
                        addLog('warn', `No se pudo descifrar voto de encuesta para ${sender}: ${lastDecryptError?.message || 'Sin opciones'}`)
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
                    SET state = 'AWAITING_AFFECTATIONS_AND_DESC',
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

    // 4. Estado: AWAITING_AFFECTATIONS_AND_DESC (Afectaciones y descripción opcional)
    if (session.state === 'AWAITING_AFFECTATIONS_AND_DESC') {
        if (text === '0' || lowerText === 'cancelar') {
            deleteSession(sender)
            const cancelMsg = 'Reporte cancelado. Escribí *REPORTAR* cuando quieras comenzar de nuevo.'
            await sock.sendMessage(sender, { text: cancelMsg })
            return true
        }

        if (text === '1' || lowerText === 'listo' || lowerText === 'continuar') {
            db.prepare(`
                UPDATE report_sessions
                SET state = 'AWAITING_DESCRIPTION',
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(sender)

            const descPrompt = `✍️ *Descripción del incidente (opcional)*\n\n¿Querés agregar algún detalle sobre lo ocurrido?\n\n👉 Escribí tu descripción o respondé *1* para omitir.`
            await sock.sendMessage(sender, { text: descPrompt })
            addLog('message_out', `Solicitud de descripción enviada a ${sender}`)
            return true
        }

        // Selección por números de texto (ej: "1, 4" o "3")
        const rawNumbers = text.match(/\b\d+\b/g)
        const isOnlyNumbers = /^[\d\s,.-]+$/.test(text)
        if (rawNumbers && isOnlyNumbers && !(rawNumbers.length === 1 && rawNumbers[0] === '1')) {
            const validIndices = []
            for (const numStr of rawNumbers) {
                const num = parseInt(numStr, 10)
                if (num >= 1 && num <= AFFECTATION_CATEGORIES.length && !validIndices.includes(num)) {
                    validIndices.push(num)
                }
            }

            if (validIndices.length > 0) {
                const selectedCategories = validIndices.map(i => AFFECTATION_CATEGORIES[i - 1])
                db.prepare(`
                    UPDATE report_sessions
                    SET selected_affectations = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_jid = ?
                `).run(JSON.stringify(selectedCategories), sender)

                const numConfirm = `Afectaciones registradas: ${selectedCategories.join(', ')}.\n\n👉 Respondé *1* o *LISTO* para continuar.\n👉 Respondé *0* o *CANCELAR* para salir.`
                await sock.sendMessage(sender, { text: numConfirm })
                return true
            }
        }

        // Detección por texto coincidente con categorías oficiales (ej: "calle inundada", "árbol caído")
        const matchedCategories = AFFECTATION_CATEGORIES.filter(cat =>
            lowerText.includes(cat.toLowerCase())
        )
        if (matchedCategories.length > 0) {
            let currentList = []
            try {
                currentList = JSON.parse(session.selected_affectations || '[]')
            } catch (_) {}
            const merged = Array.from(new Set([...currentList, ...matchedCategories]))
            db.prepare(`
                UPDATE report_sessions
                SET selected_affectations = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_jid = ?
            `).run(JSON.stringify(merged), sender)

            addLog('info', `Afectaciones registradas por texto para ${sender}: ${merged.join(', ')}`)

            const numConfirm = `Afectaciones registradas: ${merged.join(', ')}.\n\n👉 Respondé *1* o *LISTO* para continuar.\n👉 Respondé *0* o *CANCELAR* para salir.`
            await sock.sendMessage(sender, { text: numConfirm })
            return true
        }

        const helpStep = `👉 Respondé *1* o *LISTO* para continuar.\n👉 Respondé *0* o *CANCELAR* para salir.`
        db.prepare('UPDATE report_sessions SET updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?').run(sender)
        await sock.sendMessage(sender, { text: helpStep })
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
            const confirmedSession = db.prepare('SELECT latitude, longitude, selected_affectations, photo_path, description FROM report_sessions WHERE user_jid = ?').get(sender) || session
            db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(sender)

            const finalMsg = `✅ *¡Reporte recibido correctamente!*\n\n¡Muchas gracias por tu colaboración! 🙌\n\nTu reporte contribuirá al monitoreo de inundaciones urbanas y a la identificación de zonas afectadas.\n\n🗺️ *¡Explorá nuestro mapa interactivo!*\n\nPodés visualizar los reportes de inundaciones en nuestra plataforma web:\n\n🔗 https://mapa-chi-steel.vercel.app/`
            await sock.sendMessage(sender, { text: finalMsg })
            addLog('message_out', `Reporte confirmado por ${sender}. Sesión cerrada.`)

            // Sincronización asíncrona hacia Supabase (no bloquea al usuario)
            if (isSupabaseConfigured()) {
                syncReportToSupabase(confirmedSession)
                    .then(syncRes => {
                        // Solo eliminar la foto local si AMBOS fueron exitosos: subida a Storage (publicUrl) Y registro en DB (success)
                        if (syncRes.success && syncRes.publicUrl) {
                            addLog('info', `☁️ Reporte y fotografía sincronizados en Supabase (ID: ${syncRes.report?.id || 'OK'})`)
                            if (confirmedSession.photo_path) {
                                safeDeleteUploadFile(confirmedSession.photo_path)
                            }
                        } else if (syncRes.success && !syncRes.publicUrl) {
                            addLog('warn', `⚠️ Reporte guardado en DB pero la foto no se pudo subir a Storage. Se conserva foto local: ${confirmedSession.photo_path}`)
                        } else {
                            addLog('error', `⚠️ Fallo de sincronización con Supabase: ${syncRes.error}`)
                        }
                    })
                    .catch(syncErr => {
                        addLog('error', `⚠️ Excepción al sincronizar con Supabase: ${syncErr.message}`)
                    })
            } else {
                addLog('info', 'Supabase no está configurado en .env. El reporte se procesó localmente.')
            }

            return true
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

    // Programar limpieza periódica cada 15 minutos en segundo plano (sin mensajes a usuarios)
    if (!global.cleanupInterval) {
        global.cleanupInterval = setInterval(cleanupExpiredSessionsAndFiles, 15 * 60 * 1000)
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

// Exportación para suite de pruebas
if (process.env.NODE_ENV === 'test') {
    module.exports = {
        db,
        SESSION_TIMEOUT_MS,
        parseSessionUtcTimestamp,
        isSessionExpired,
        safeDeleteUploadFile,
        deleteSession,
        cleanupExpiredSessionsAndFiles,
        handleFloodReportFlow,
        AFFECTATION_CATEGORIES,
        UPLOADS_DIR
    }
}

// Iniciar bot solo en ejecución directa y fuera de pruebas
if (require.main === module && process.env.NODE_ENV !== 'test') {
    connectToWhatsApp().catch(err => {
        console.error('❌ Error crítico al arrancar FloodBot:', err)
    })
}
