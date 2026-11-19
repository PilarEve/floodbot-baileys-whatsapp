// ==============================================================================
// FloodBot - Servidor de Simulación Visual Interactiva
// ==============================================================================
// Entorno 100% aislado para probar en navegador el comportamiento real de FloodBot
// y la atención manual por asesor sin conexión a WhatsApp ni a Supabase.
// ==============================================================================

const http = require('http')
const fs = require('fs')
const path = require('path')

// 1. Configuración de aislamiento en test_sim_web/
const simDir = path.resolve(__dirname, 'test_sim_web')
if (!fs.existsSync(simDir)) fs.mkdirSync(simDir, { recursive: true })

const simUploads = path.join(simDir, 'uploads_sim')
if (!fs.existsSync(simUploads)) fs.mkdirSync(simUploads, { recursive: true })

const simDbPath = path.join(simDir, 'sessions_sim.db')
const simAuthPath = path.join(simDir, 'auth_sim')
if (!fs.existsSync(simAuthPath)) fs.mkdirSync(simAuthPath, { recursive: true })

process.env.NODE_ENV = 'test'
process.env.UPLOADS_DIR = simUploads
process.env.DB_PATH = simDbPath
process.env.AUTH_DIR = simAuthPath
process.env.OUTGOING_RATE_LIMIT_MS = '50' // Respuesta rápida para la UI

// 2. Interceptar descarga de imágenes de Baileys para no requerir conexión
const Module = require('module')
const originalRequire = Module.prototype.require
Module.prototype.require = function (modulePath) {
    const loadedModule = originalRequire.apply(this, arguments)
    if (modulePath === '@whiskeysockets/baileys') {
        return {
            ...loadedModule,
            downloadMediaMessage: async () => Buffer.from('SIMULATED_TEST_PHOTO_DATA')
        }
    }
    return loadedModule
}

// 3. Importar lógica real de FloodBot
const {
    handleFloodReportFlow,
    handleAdvisorOutgoingMessage,
    getAdvisorSession,
    closeAdvisorSession,
    clearAdvisorSession,
    activateAdvisorSession,
    recordBotOutgoingMessageId,
    isBotOutgoingMessageId,
    isAdvisorClosingMessage,
    deleteSession,
    cleanupExpiredSessionsAndFiles,
    updateSavedReportData,
    touchAdvisorSessionActivity,
    isAdvisorSessionExpired,
    ADVISOR_ACTIVE_TIMEOUT_MS,
    db,
    defaultQueue,
    AFFECTATION_CATEGORIES
} = require('./bot')

const PORT = process.env.SIM_PORT || 3000
const CITIZEN_JID = '595981234567@s.whatsapp.net'

// Historial en memoria de mensajes de la simulación
let chatHistory = []

// 4. Socket virtual para capturar mensajes salientes de FloodBot
const mockSock = {
    user: { id: '595980000000:0@s.whatsapp.net', lid: '123456789@lid' },
    sendMessage: async (jid, content, options) => {
        const msgId = 'BOT_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7)
        recordBotOutgoingMessageId(msgId)

        let text = ''
        let poll = null

        if (content.text) {
            text = content.text
        } else if (content.poll) {
            poll = {
                title: content.poll.name,
                options: content.poll.values,
                selectableCount: content.poll.selectableCount || 1
            }
            text = `📊 *${content.poll.name}*\n\n` + content.poll.values.map((v, i) => `${i + 1}. ${v}`).join('\n')
        }

        const botMsg = {
            id: msgId,
            sender: 'bot',
            text: text,
            poll: poll,
            timestamp: Date.now()
        }

        chatHistory.push(botMsg)
        return { key: { id: msgId, remoteJid: jid } }
    }
}

// Enlazar socket a la cola saliente
defaultQueue.setSocket(mockSock)

// Helper para obtener el estado actual consolidado
function getCurrentState() {
    const advisor = getAdvisorSession(CITIZEN_JID)
    const session = db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(CITIZEN_JID) || null
    const pending = db.prepare('SELECT * FROM pending_sync_reports WHERE user_jid = ?').get(CITIZEN_JID) || null

    let mode = 'IDLE'
    let statusLabel = '⚪ En Reposo (Sin sesión activa)'
    let statusType = 'idle'
    let cooldownRemainingSeconds = 0

    if (advisor && advisor.status === 'ACTIVE') {
        if (isAdvisorSessionExpired(advisor)) {
            mode = 'IDLE'
            statusLabel = '🟢 Atención Manual Expirada (>2h silencio) - Listo'
            statusType = 'idle'
        } else {
            mode = 'ADVISOR_ACTIVE'
            statusLabel = '🟡 Atención Manual por Asesor Activa'
            statusType = 'advisor'
        }
    } else if (advisor && advisor.status === 'COOLDOWN') {
        const elapsedMs = Date.now() - (advisor.closed_at_ms || 0)
        const remainingMs = Math.max(0, (15 * 60 * 1000) - elapsedMs)
        cooldownRemainingSeconds = Math.ceil(remainingMs / 1000)

        if (remainingMs > 0) {
            mode = 'ADVISOR_COOLDOWN'
            statusLabel = `⏱️ Enfriamiento Post-Asesor (${Math.ceil(remainingMs / 60000)} min restantes)`
            statusType = 'cooldown'
        } else {
            mode = 'COOLDOWN_EXPIRED'
            statusLabel = '🟢 Enfriamiento Vencido (Listo para nuevo reporte)'
            statusType = 'idle'
        }
    } else if (session) {
        mode = 'BOT_ACTIVE'
        statusLabel = `🟢 Flujo Automático Bot (${session.state})`
        statusType = 'auto'
    }

    return {
        mode,
        statusLabel,
        statusType,
        cooldownRemainingSeconds,
        session,
        advisor,
        pending,
        affectationCategories: AFFECTATION_CATEGORIES,
        messages: chatHistory
    }
}

// 5. Servidor HTTP
const server = http.createServer(async (req, res) => {
    // CORS headers para desarrollo local
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)

    // 1. Servir Frontend HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'simulacion_web.html')
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(fs.readFileSync(htmlPath, 'utf8'))
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('simulacion_web.html no encontrado')
        }
        return
    }

    // 2. API: Obtener estado actual
    if (url.pathname === '/api/state' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getCurrentState()))
        return
    }

    // Helper para parsear JSON body
    const parseBody = () => new Promise((resolve) => {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {})
            } catch (_) {
                resolve({})
            }
        })
    })

    // 3. API: Enviar mensaje (como ciudadano o como asesor)
    if (url.pathname === '/api/send' && req.method === 'POST') {
        const data = await parseBody()
        const role = data.role || 'citizen' // 'citizen' o 'advisor'
        const type = data.type || 'text' // 'text', 'location', 'photo', 'poll_vote'
        const text = (data.text || '').trim()

        if (role === 'advisor') {
            // MENSAJE SALIENTE DEL ASESOR
            chatHistory.push({
                id: 'ADV_' + Date.now(),
                sender: 'advisor',
                type: 'text',
                text: text,
                timestamp: Date.now()
            })

            const advisorMsg = {
                key: {
                    remoteJid: CITIZEN_JID,
                    id: '3EB0_MANUAL_' + Date.now(),
                    fromMe: true
                },
                message: { conversation: text }
            }

            await handleFloodReportFlow(mockSock, CITIZEN_JID, advisorMsg)
            await new Promise(r => setTimeout(r, 100))

        } else {
            // MENSAJE ENTRANTE DEL CIUDADANO
            if (type === 'poll_vote') {
                const selected = data.selectedOptions || [text]
                chatHistory.push({
                    id: 'VOTE_' + Date.now(),
                    sender: 'citizen',
                    type: 'poll_vote',
                    text: `⛈️ Voto en encuesta: ${selected.join(', ')}`,
                    timestamp: Date.now()
                })

                db.prepare('UPDATE report_sessions SET selected_affectations = ?, updated_at = CURRENT_TIMESTAMP WHERE user_jid = ?')
                    .run(JSON.stringify(selected), CITIZEN_JID)
                await updateSavedReportData(CITIZEN_JID)

            } else if (type === 'location') {
                const lat = typeof data.lat === 'number' ? data.lat : -25.2981
                const lng = typeof data.lng === 'number' ? data.lng : -57.5319

                chatHistory.push({
                    id: 'LOC_' + Date.now(),
                    sender: 'citizen',
                    type: 'location',
                    text: `📍 Ubicación compartida: (${lat.toFixed(6)}, ${lng.toFixed(6)})`,
                    lat,
                    lng,
                    timestamp: Date.now()
                })

                const locMsg = {
                    key: { remoteJid: CITIZEN_JID, id: 'MSG_' + Date.now(), fromMe: false },
                    message: {
                        locationMessage: {
                            degreesLatitude: lat,
                            degreesLongitude: lng
                        }
                    }
                }
                await handleFloodReportFlow(mockSock, CITIZEN_JID, locMsg)

            } else if (type === 'photo') {
                chatHistory.push({
                    id: 'IMG_' + Date.now(),
                    sender: 'citizen',
                    type: 'photo',
                    text: `📸 [Fotografía enviada] ${text ? `"${text}"` : ''}`,
                    imagePreview: data.imagePreview || null,
                    timestamp: Date.now()
                })

                const imgMsg = {
                    key: { remoteJid: CITIZEN_JID, id: 'MSG_' + Date.now(), fromMe: false },
                    message: {
                        imageMessage: {
                            caption: text || 'Foto de anegamiento'
                        }
                    }
                }
                await handleFloodReportFlow(mockSock, CITIZEN_JID, imgMsg)

            } else {
                // Texto estándar
                chatHistory.push({
                    id: 'TXT_' + Date.now(),
                    sender: 'citizen',
                    type: 'text',
                    text: text,
                    timestamp: Date.now()
                })

                const textMsg = {
                    key: { remoteJid: CITIZEN_JID, id: 'MSG_' + Date.now(), fromMe: false },
                    message: { conversation: text }
                }
                await handleFloodReportFlow(mockSock, CITIZEN_JID, textMsg)
            }

            // Esperar brevemente para que la cola entregue cualquier respuesta encadenada del bot
            await new Promise(r => setTimeout(r, 220))
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getCurrentState()))
        return
    }

    // 4. API: Adelantar 15 minutos (Fast-Forward)
    if (url.pathname === '/api/fast-forward' && req.method === 'POST') {
        const advisor = getAdvisorSession(CITIZEN_JID)
        let noticeText = ''

        if (advisor && advisor.status === 'ACTIVE') {
            // Caso A: El asesor está conversando en vivo
            noticeText = 'ℹ️ El asesor está actualmente ACTIVO. Durante la atención manual, el cierre automático de 15 minutos está pausado por diseño para no interrumpir tu diálogo. Para iniciar la espera de 15 min, el asesor debe enviar el mensaje de cierre: "Gracias. Reporte recibido".'
        } else if (advisor && advisor.status === 'COOLDOWN') {
            // Caso B: El asesor ya cerró y está en enfriamiento
            const sixteenMinAgo = Date.now() - (16 * 60 * 1000)
            db.prepare(`
                UPDATE advisor_sessions
                SET closed_at_ms = ?,
                    closed_at = datetime('now', '-16 minutes')
                WHERE user_jid = ?
            `).run(sixteenMinAgo, CITIZEN_JID)

            noticeText = '⏱️ [SIMULACIÓN] Transcurrieron los 15 minutos de enfriamiento post-asesor. La conversación volvió al estado inicial. El próximo mensaje del ciudadano activará el saludo inicial de FloodBot.'
        } else {
            // Caso C: Flujo normal de reporte
            db.prepare(`
                UPDATE report_sessions
                SET updated_at = datetime('now', '-16 minutes')
                WHERE user_jid = ?
            `).run(CITIZEN_JID)

            noticeText = '⏱️ [SIMULACIÓN] Transcurrieron 15 minutos de inactividad.'
        }

        chatHistory.push({
            id: 'SYS_' + Date.now(),
            sender: 'system',
            type: 'system_notice',
            text: noticeText,
            timestamp: Date.now()
        })

        // Ejecutar rutina de limpieza de inactividad
        await cleanupExpiredSessionsAndFiles(mockSock)
        await new Promise(r => setTimeout(r, 200))

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getCurrentState()))
        return
    }

    // 4.b. API: Adelantar 2 Horas (Simular abandono de asesor / inactividad prolongada)
    if (url.pathname === '/api/fast-forward-2h' && req.method === 'POST') {
        const twoHoursAgo = Date.now() - (121 * 60 * 1000)

        // Envejecer sesión de asesor activa
        db.prepare(`
            UPDATE advisor_sessions
            SET last_activity_ms = ?,
                started_at = datetime('now', '-121 minutes')
            WHERE user_jid = ?
        `).run(twoHoursAgo, CITIZEN_JID)

        // Envejecer sesión de reporte si existía
        db.prepare(`
            UPDATE report_sessions
            SET updated_at = datetime('now', '-121 minutes')
            WHERE user_jid = ?
        `).run(CITIZEN_JID)

        // Ejecutar limpieza para que libere automáticamente
        await cleanupExpiredSessionsAndFiles(mockSock)
        await new Promise(r => setTimeout(r, 200))

        const noticeText = '⌛ [SIMULACIÓN] Transcurrieron más de 2 horas de silencio total en atención manual. Por seguridad, la sesión de asesor se liberó automáticamente. El próximo mensaje del ciudadano activará el flujo normal de FloodBot.'
        chatHistory.push({
            id: 'SYS_' + Date.now(),
            sender: 'system',
            type: 'system_notice',
            text: noticeText,
            timestamp: Date.now()
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getCurrentState()))
        return
    }

    // 5. API: Reiniciar conversación
    if (url.pathname === '/api/reset' && req.method === 'POST') {
        try {
            db.prepare('DELETE FROM report_sessions WHERE user_jid = ?').run(CITIZEN_JID)
            db.prepare('DELETE FROM advisor_sessions WHERE user_jid = ?').run(CITIZEN_JID)
            db.prepare('DELETE FROM pending_sync_reports WHERE user_jid = ?').run(CITIZEN_JID)
        } catch (_) {}

        chatHistory = []
        defaultQueue.cancelForJid(CITIZEN_JID)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(getCurrentState()))
        return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Ruta no encontrada')
})

server.listen(PORT, () => {
    console.log('=================================================================')
    console.log(`🌐 SIMULADOR VISUAL DE FLOODBOT ACTIVO`)
    console.log(`👉 Abrí en tu navegador: http://localhost:${PORT}`)
    console.log('🛡️  Aislamiento total: WhatsApp, Supabase y sessions.db están protegidos.')
    console.log('=================================================================')
})
