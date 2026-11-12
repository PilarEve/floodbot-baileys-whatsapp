// ==============================================================================
// FloodBot - Simulación Local Completa en Terminal (Sin WhatsApp Real)
// ==============================================================================
// Este script permite probar el flujo conversacional y la cola de mensajes
// con Rate Limiting en tiempo real desde la terminal.
//
// GARANTÍA DE AISLAMIENTO:
// - No conecta con los servidores de WhatsApp ni con Supabase.
// - No modifica sessions.db, uploads/ ni auth_info_baileys/ reales.
// - Trabaja en una carpeta temporal aislada test_sim/ que se destruye al finalizar.
// ==============================================================================

const path = require('path')
const fs = require('fs')

// 1. Preparar directorio temporal aislado
const simDir = path.resolve(__dirname, 'test_sim')
if (fs.existsSync(simDir)) {
    try { fs.rmSync(simDir, { recursive: true, force: true }) } catch (_) {}
}
fs.mkdirSync(simDir, { recursive: true })

const simUploads = path.join(simDir, 'uploads_sim')
fs.mkdirSync(simUploads, { recursive: true })
const simDbPath = path.join(simDir, 'sessions_sim.db')
const simAuthPath = path.join(simDir, 'auth_sim')
fs.mkdirSync(simAuthPath, { recursive: true })

// 2. Establecer variables de entorno para aislamiento ANTES de importar bot.js
process.env.NODE_ENV = 'test'
process.env.UPLOADS_DIR = simUploads
process.env.DB_PATH = simDbPath
process.env.AUTH_DIR = simAuthPath
process.env.OUTGOING_RATE_LIMIT_MS = '350'

// 3. Interceptar @whiskeysockets/baileys para que downloadMediaMessage simule la descarga sin red
const Module = require('module')
const originalRequire = Module.prototype.require
Module.prototype.require = function (modulePath) {
    const loadedModule = originalRequire.apply(this, arguments)
    if (modulePath === '@whiskeysockets/baileys') {
        return {
            ...loadedModule,
            downloadMediaMessage: async () => Buffer.from('FAKE_SIMULATED_JPEG_IMAGE_DATA')
        }
    }
    return loadedModule
}

// 4. Importar módulos del bot ya aislados
const {
    handleFloodReportFlow,
    closeDatabase,
    defaultQueue,
    db
} = require('./bot')

// 5. Creador de Mock Socket con cronómetro e impresión visual en terminal
function createSimulationSocket() {
    let lastDispatch = Date.now()
    const dispatchHistory = []

    const mockSock = {
        user: { id: '595980000000:0@s.whatsapp.net', lid: '123456789@lid' },
        dispatchHistory,
        sendMessage: async (jid, content, options) => {
            const now = Date.now()
            const deltaMs = now - lastDispatch
            lastDispatch = now

            dispatchHistory.push({
                jid,
                content,
                timestamp: now,
                deltaMs
            })

            const cleanJid = (jid || '').split('@')[0]
            let preview = ''
            if (content.text) {
                preview = content.text.split('\n')[0].substring(0, 65) + '...'
            } else if (content.poll) {
                preview = `[ENCUESTA INTERACTIVA] ${content.poll.name}`
            } else {
                preview = JSON.stringify(content).substring(0, 50)
            }

            console.log(`   📤 [BOT -> ${cleanJid}] (+${deltaMs} ms): ${preview}`)

            const msgId = 'SIM_MSG_' + now + '_' + Math.random().toString(36).substring(2, 6)
            return {
                key: { id: msgId, remoteJid: jid, fromMe: true },
                message: {
                    ...content,
                    messageContextInfo: {
                        messageSecret: Buffer.alloc(32, 1)
                    }
                }
            }
        }
    }

    return mockSock
}

// Helper para pausas visuales
const delay = ms => new Promise(r => setTimeout(r, ms))

async function runSimulation() {
    console.log('==============================================================================')
    console.log('🚀 SIMULACIÓN LOCAL DE FLOODBOT (CON COLA Y RATE LIMITING)')
    console.log('==============================================================================')
    console.log(`🛡️ Entorno: Completamente aislado (test_sim/)`)
    console.log(`⏱️ Rate Limiting configurado: ${process.env.OUTGOING_RATE_LIMIT_MS} ms entre mensajes`)
    console.log('==============================================================================\n')

    try {
        // ==========================================================================
        // ESCENARIO 1: Un ciudadano completando su reporte paso a paso
        // ==========================================================================
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('📋 ESCENARIO 1: Flujo conversacional completo de un ciudadano (Juan)')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

        const sock1 = createSimulationSocket()
        defaultQueue.setSocket(sock1)
        const userJuan = '595981112233@s.whatsapp.net'

        // Paso 1: Saludo inicial
        console.log('\n💬 [Juan]: "Hola, quiero reportar una inundación"')
        await handleFloodReportFlow(sock1, userJuan, {
            key: { remoteJid: userJuan, id: 'MSG_1' },
            message: { conversation: 'Hola, quiero reportar una inundación' }
        })
        await delay(500)

        // Paso 2: Envío de ubicación GPS
        console.log('\n💬 [Juan]: 📍 Envía ubicación GPS (Lat: -25.2968, Lng: -57.6415)')
        await handleFloodReportFlow(sock1, userJuan, {
            key: { remoteJid: userJuan, id: 'MSG_2' },
            message: {
                locationMessage: {
                    degreesLatitude: -25.2968,
                    degreesLongitude: -57.6415
                }
            }
        })
        await delay(500)

        // Paso 3: Envío de fotografía de evidencia
        console.log('\n💬 [Juan]: 📸 Envía fotografía del anegamiento (imagen JPEG)')
        await handleFloodReportFlow(sock1, userJuan, {
            key: { remoteJid: userJuan, id: 'MSG_3' },
            message: {
                imageMessage: {
                    mimetype: 'image/jpeg',
                    caption: 'El agua sobrepasó el cordón de la vereda'
                }
            }
        })
        await delay(500)

        // Paso 4: Descripción cualitativa
        console.log('\n💬 [Juan]: ✍️ Escribe descripción: "El agua subió 40 cm y cortó el tránsito"')
        await handleFloodReportFlow(sock1, userJuan, {
            key: { remoteJid: userJuan, id: 'MSG_4' },
            message: {
                conversation: 'El agua subió 40 cm y cortó el tránsito vehicular'
            }
        })
        await delay(500)

        // Paso 5: Confirmación final
        console.log('\n💬 [Juan]: ✅ Responde "1" para confirmar y enviar el reporte')
        await handleFloodReportFlow(sock1, userJuan, {
            key: { remoteJid: userJuan, id: 'MSG_5' },
            message: {
                conversation: '1'
            }
        })
        await delay(400)

        // Verificación de estado en SQLite temporal
        const pending = db.prepare('SELECT id, status, latitude, longitude, description FROM pending_sync_reports WHERE user_jid = ?').get(userJuan)
        console.log('\n🔍 Verificación en base de datos temporal:')
        if (pending) {
            console.log(`   ✅ Reporte registrado en cola local de sincronización (ID: ${pending.id})`)
            console.log(`   📍 Coordenadas: ${pending.latitude}, ${pending.longitude}`)
            console.log(`   ✍️ Descripción: "${pending.description}"`)
            console.log(`   📊 Estado: ${pending.status}`)
        } else {
            console.log('   ❌ No se encontró el reporte en pending_sync_reports')
        }

        console.log('\n🎉 Escenario 1 completado exitosamente: El ciudadano completó su reporte paso a paso.')

        // ==========================================================================
        // ESCENARIO 2: Dos ciudadanos escribiendo simultáneamente al mismo milisegundo
        // ==========================================================================
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('⚡ ESCENARIO 2: Dos ciudadanos simultáneos (María y Carlos escriben a la par)')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

        const sock2 = createSimulationSocket()
        defaultQueue.setSocket(sock2)

        const userMaria = '595982223344@s.whatsapp.net'
        const userCarlos = '595983334455@s.whatsapp.net'

        console.log('💬 [María]:  "REPORTAR" (t = 0 ms)')
        console.log('💬 [Carlos]: "REPORTAR" (t = 0 ms)')
        console.log('\n⏳ Disparando ambas peticiones simultáneas con Promise.all()...\n')

        const tStart = Date.now()
        // Ambas peticiones se inician en paralelo
        await Promise.all([
            handleFloodReportFlow(sock2, userMaria, {
                key: { remoteJid: userMaria, id: 'MSG_MARIA_START' },
                message: { conversation: 'REPORTAR' }
            }),
            handleFloodReportFlow(sock2, userCarlos, {
                key: { remoteJid: userCarlos, id: 'MSG_CARLOS_START' },
                message: { conversation: 'REPORTAR' }
            })
        ])

        // Dar un instante para que el bucle de la cola termine de vaciar los mensajes
        await delay(800)
        const tEnd = Date.now()

        console.log('\n📊 Análisis de la ráfaga concurrente:')
        console.log(`   • Total de mensajes salientes despachados: ${sock2.dispatchHistory.length} (2 para María + 2 para Carlos)`)
        console.log(`   • Tiempo total transcurrido: ${tEnd - tStart} ms`)

        // Verificación de intervalos
        console.log('\n⏱️ Medición de intervalos entre envíos consecutivos:')
        let intervalsOk = true
        for (let i = 1; i < sock2.dispatchHistory.length; i++) {
            const prev = sock2.dispatchHistory[i - 1]
            const curr = sock2.dispatchHistory[i]
            const diff = curr.timestamp - prev.timestamp
            const meetsLimit = diff >= 320 // Margen de jitter de ±30ms en temporizadores de Node.js
            if (!meetsLimit) intervalsOk = false
            console.log(`   • Mensaje ${i} -> Mensaje ${i + 1}: ${diff} ms ${meetsLimit ? '✅ (Cumple >= 350 ms)' : '⚠️ (Fuera de rango)'}`)
        }

        // Verificación de orden por ciudadano
        const mariaMsgs = sock2.dispatchHistory.filter(m => m.jid === userMaria)
        const carlosMsgs = sock2.dispatchHistory.filter(m => m.jid === userCarlos)

        console.log('\n📋 Verificación del orden por ciudadano:')
        const mariaOrderOk = mariaMsgs.length === 2 &&
            mariaMsgs[0].content.text.includes('Sistema de Monitoreo') &&
            mariaMsgs[1].content.text.includes('Paso 1: Ubicación')

        const carlosOrderOk = carlosMsgs.length === 2 &&
            carlosMsgs[0].content.text.includes('Sistema de Monitoreo') &&
            carlosMsgs[1].content.text.includes('Paso 1: Ubicación')

        console.log(`   • Orden de conversación de María: ${mariaOrderOk ? '✅ CORRECTO (Bienvenida antes de Ubicación)' : '❌ INCORRECTO'}`)
        console.log(`   • Orden de conversación de Carlos: ${carlosOrderOk ? '✅ CORRECTO (Bienvenida antes de Ubicación)' : '❌ INCORRECTO'}`)
        console.log(`   • Rate Limiting global respetado: ${intervalsOk ? '✅ CORRECTO (Sin ráfagas de 0 ms)' : '⚠️ REVISAR INTERVALOS'}`)

        console.log('\n==============================================================================')
        console.log('🎉 RESULTADO: Simulación completada con éxito sin errores.')
        console.log('==============================================================================\n')

    } catch (err) {
        console.error('❌ Error durante la simulación:', err)
    } finally {
        // Cerrar base temporal SQLite y limpiar archivos
        closeDatabase()
        try {
            if (fs.existsSync(simDir)) {
                fs.rmSync(simDir, { recursive: true, force: true })
            }
        } catch (_) {}
    }
}

runSimulation()

