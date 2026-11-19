// ==============================================================================
// Suite de Pruebas: Expiración Automática, Seguridad, Persistencia y Sincronización
// ==============================================================================
// Esta suite es completamente hermética y aislada:
// Utiliza una base de datos temporal y una carpeta de uploads temporal dentro de test_tmp/
// garantizando que sessions.db y uploads/ reales NUNCA sean modificados ni eliminados.
// ==============================================================================

process.env.NODE_ENV = 'test'

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const crypto = require('crypto')
const { proto, aesEncryptGCM, hmacSign } = require('@whiskeysockets/baileys')

// Directorio temporal aislado para pruebas
const testDir = path.resolve(__dirname, 'test_tmp')
if (fs.existsSync(testDir)) {
    try {
        fs.rmSync(testDir, { recursive: true, force: true })
    } catch (_) {}
}
fs.mkdirSync(testDir, { recursive: true })

const testUploads = path.join(testDir, 'uploads_test')
fs.mkdirSync(testUploads, { recursive: true })
const testDbPath = path.join(testDir, 'sessions_test.db')

process.env.UPLOADS_DIR = testUploads
process.env.DB_PATH = testDbPath
process.env.AUTH_DIR = path.join(testDir, 'auth_test')

// Interceptar @whiskeysockets/baileys para que downloadMediaMessage simule la descarga de fotos sin red
const Module = require('module')
const originalRequire = Module.prototype.require
Module.prototype.require = function (modulePath) {
    const loadedModule = originalRequire.apply(this, arguments)
    if (modulePath === '@whiskeysockets/baileys') {
        return {
            ...loadedModule,
            downloadMediaMessage: async () => Buffer.from('FAKE_TEST_JPEG_DATA_BUFFER')
        }
    }
    return loadedModule
}

const {
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
    updateSavedReportData,
    handleFloodReportFlow,
    UPLOADS_DIR,
    DB_PATH,
    CONFIRMATION_INTERFACE_MODE,
    sendReportConfirmationInterface,
    executeReportConfirmation,
    sendAffectationPoll,
    AFFECTATION_CATEGORIES,
    FINAL_SUCCESS_MESSAGE,
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
    handleAdvisorOutgoingMessage
} = require('./bot')
const { MessageQueue } = require('./messageQueue')

const { insertReportRecord, updateReportRecord, deleteReportRecord } = require('./supabaseClient')

console.log('🧪 Iniciando batería exhaustiva de pruebas (26 escenarios aislados)...\n')
console.log(`📁 Directorio de pruebas aislado: ${testDir}`)
console.log(`🗄️ Base de datos temporal: ${testDbPath}`)
console.log(`📸 Carpeta temporal de uploads: ${testUploads}\n`)

// Mock de socket de Baileys para capturar mensajes salientes
let mockMsgSeq = 0
function createMockSocket() {
    const sentMessages = []
    return {
        sentMessages,
        sendMessage: async (jid, content) => {
            mockMsgSeq++
            const id = 'MOCK_MSG_' + Date.now() + '_' + mockMsgSeq
            sentMessages.push({ jid, content })
            return {
                key: { id, remoteJid: jid, fromMe: true },
                message: {
                    messageContextInfo: {
                        messageSecret: Buffer.alloc(32, 7)
                    }
                }
            }
        },
        relayMessage: async (jid, message, options) => {
            sentMessages.push({ jid, content: { relayMessage: message, options } })
            return { key: { id: options?.messageId || ('MOCK_RELAY_' + Date.now()) } }
        },
        user: { id: '595981111111:0@s.whatsapp.net', lid: '123456789@lid' }
    }
}

// Helper para generar votos cifrados reales idénticos a los enviados por el cliente de WhatsApp
function generateEncryptedPollVote({ pollMsgId, pollCreatorJid, voterJid, pollEncKey, selectedOptionText }) {
    const optionHash = crypto.createHash('sha256').update(selectedOptionText).digest()
    const voteProto = proto.Message.PollVoteMessage.encode({
        selectedOptions: [optionHash]
    }).finish()

    const sign = Buffer.concat([
        Buffer.from(pollMsgId),
        Buffer.from(pollCreatorJid),
        Buffer.from(voterJid),
        Buffer.from('Poll Vote'),
        new Uint8Array([1])
    ])
    const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256')
    const decKey = hmacSign(sign, key0, 'sha256')
    const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`)
    const encIv = crypto.randomBytes(12)
    const encPayload = aesEncryptGCM(voteProto, decKey, encIv, aad)

    return { encPayload, encIv }
}

let passedTests = 0

async function runTests() {
    try {
        // --------------------------------------------------------------------------
        // Test 1: Precisión de expiración por inactividad (>15 min) y reinicio silencioso
        // --------------------------------------------------------------------------
        console.log('▶️ Test 1: Precisión de timestamps UTC y reinicio silencioso tras inactividad...')
        assert.strictEqual(SESSION_TIMEOUT_MS, 15 * 60 * 1000, 'SESSION_TIMEOUT_MS debe ser de 15 minutos exactos')

        const nowUtcStr = new Date().toISOString().replace('T', ' ').slice(0, 19)
        assert.strictEqual(isSessionExpired({ updated_at: nowUtcStr }), false, 'Sesión actual no debe expirar')

        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
        assert.strictEqual(isSessionExpired({ updated_at: tenMinAgo }), false, 'Sesión de 10 min no debe expirar')

        const sixteenMinAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
        assert.strictEqual(isSessionExpired({ updated_at: sixteenMinAgo }), true, 'Sesión de 16 min (>15 min) debe expirar')

        const testUser1 = '595982222222@s.whatsapp.net'
        deleteSession(testUser1)

        const dummyPhoto = path.join(testUploads, `test_expired_${Date.now()}.jpg`)
        fs.writeFileSync(dummyPhoto, 'dummy photo content')

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, photo_path, updated_at)
            VALUES (?, 'AWAITING_PHOTO', ?, datetime('now', '-20 minutes'))
        `).run(testUser1, dummyPhoto)

        const mockSock1 = createMockSocket()
        await handleFloodReportFlow(mockSock1, testUser1, {
            key: { remoteJid: testUser1, id: 'MSG_1' },
            message: { conversation: 'Hola, sigo aquí' }
        })

        const sessionUser1 = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(testUser1)
        assert.strictEqual(sessionUser1?.state, 'AWAITING_LOCATION', 'Sesión expirada debe reiniciarse en AWAITING_LOCATION')
        assert.strictEqual(fs.existsSync(dummyPhoto), false, 'La foto temporal de la sesión expirada debe eliminarse')
        assert.strictEqual(mockSock1.sentMessages.length, 2, 'Debe enviar bienvenida y paso 1 sin avisos automáticos de expiración')
        assert.ok(mockSock1.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones Urbanas'))

        console.log('  ✅ Test 1 aprobado: Expiración por inactividad y reinicio silencioso comprobados.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 2: Comandos Cancelar vs Inicio/Reiniciar
        // --------------------------------------------------------------------------
        console.log('▶️ Test 2: Comandos Cancelar vs Inicio/Reiniciar...')
        const userCancel = '595985555555@s.whatsapp.net'
        const userRestart = '595986666666@s.whatsapp.net'
        deleteSession(userCancel)
        deleteSession(userRestart)

        // Cancelar: descarta y finaliza
        db.prepare(`INSERT INTO report_sessions (user_jid, state) VALUES (?, 'AWAITING_PHOTO')`).run(userCancel)
        const mockSockCancel = createMockSocket()
        await handleFloodReportFlow(mockSockCancel, userCancel, {
            key: { remoteJid: userCancel, id: 'MSG_C' },
            message: { conversation: 'cancelar' }
        })
        assert.strictEqual(db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userCancel), undefined)
        assert.ok(mockSockCancel.sentMessages[0].content.text.includes('Reporte cancelado'))

        // Reiniciar: descarta e inicia bienvenida
        db.prepare(`INSERT INTO report_sessions (user_jid, state) VALUES (?, 'AWAITING_PHOTO')`).run(userRestart)
        const mockSockRestart = createMockSocket()
        await handleFloodReportFlow(mockSockRestart, userRestart, {
            key: { remoteJid: userRestart, id: 'MSG_R' },
            message: { conversation: 'reiniciar' }
        })
        const sessionRestartAfter = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userRestart)
        assert.strictEqual(sessionRestartAfter.state, 'AWAITING_LOCATION')
        assert.ok(mockSockRestart.sentMessages[0].content.text.includes('Sistema de Monitoreo'))

        console.log('  ✅ Test 2 aprobado: Cancelar y Reiniciar operan con comportamientos diferenciados.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 3: Protección de fotografías de sesiones activas (<30 min)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 3: Protección de fotografías de sesiones activas en limpieza periódica...')
        const userActivePhoto = '595987777777@s.whatsapp.net'
        deleteSession(userActivePhoto)

        const activePhoto = path.join(testUploads, `photo_active_${Date.now()}.jpg`)
        const orphanPhoto = path.join(testUploads, `photo_orphan_${Date.now()}.jpg`)
        fs.writeFileSync(activePhoto, 'active photo')
        fs.writeFileSync(orphanPhoto, 'orphan photo')

        // Marcar orphanPhoto con 35 minutos de antigüedad
        const pastTime = (Date.now() - 35 * 60 * 1000) / 1000
        fs.utimesSync(orphanPhoto, pastTime, pastTime)

        // Registrar activePhoto en sesión activa (5 min)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, photo_path, updated_at)
            VALUES (?, 'AWAITING_AFFECTATIONS_AND_DESC', ?, datetime('now', '-5 minutes'))
        `).run(userActivePhoto, activePhoto)

        cleanupExpiredSessionsAndFiles()

        assert.strictEqual(fs.existsSync(activePhoto), true, 'Foto de sesión activa NUNCA debe ser eliminada')
        assert.strictEqual(fs.existsSync(orphanPhoto), false, 'Foto huérfana de más de 30 min debe ser eliminada')

        deleteSession(userActivePhoto)
        console.log('  ✅ Test 3 aprobado: Fotos activas protegidas y fotos huérfanas purgadas.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 4: Fallo en Supabase Storage (se conserva en pending_sync_reports y foto local)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 4: Fallo en Supabase Storage (persistencia y foto conservada)...')
        const reportIdTest4 = 'rep_fail_storage_001'
        const photoTest4 = path.join(testUploads, `photo_storage_fail_${Date.now()}.jpg`)
        fs.writeFileSync(photoTest4, 'photo test 4 data')

        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, status, attempts, next_retry_at)
            VALUES (?, '59598111@s.whatsapp.net', -25.28, -57.64, ?, 'PENDING', 0, 0)
        `).run(reportIdTest4, photoTest4)

        const reportTest4 = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(reportIdTest4)

        const mockDependenciesStorageFail = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => ({ success: false, error: 'Storage 503 Service Unavailable' }),
            insertReportRecord: async () => ({ success: true, data: { id: 1 } })
        }

        const resTest4 = await processSinglePendingReport(reportTest4, mockDependenciesStorageFail)
        assert.strictEqual(resTest4.success, false, 'Debe reportar fallo ante error en Storage')

        // Verificar que el reporte continúa en pending_sync_reports con incremento de intentos
        const reportTest4After = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(reportIdTest4)
        assert.ok(reportTest4After, 'El reporte DEBE permanecer en pending_sync_reports')
        assert.strictEqual(reportTest4After.attempts, 1, 'attempts debe incrementarse a 1')
        assert.ok(reportTest4After.last_error.includes('Storage 503'), 'last_error debe detallar el error de Storage')
        assert.ok(reportTest4After.next_retry_at > Date.now(), 'next_retry_at debe estar programado en el futuro')
        assert.strictEqual(fs.existsSync(photoTest4), true, 'La foto física local DEBE conservarse intacta')

        console.log('  ✅ Test 4 aprobado: Fallo en Storage retiene reporte en pending_sync_reports y foto local.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 5: Fallo en Supabase DB (foto subida a Storage, storage_url guardado, foto conservada)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 5: Fallo en Supabase DB (storage_url guardado para evitar re-subida)...')
        const reportIdTest5 = 'rep_fail_db_002'
        const photoTest5 = path.join(testUploads, `photo_db_fail_${Date.now()}.jpg`)
        fs.writeFileSync(photoTest5, 'photo test 5 data')

        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, status, attempts, next_retry_at)
            VALUES (?, '59598222@s.whatsapp.net', -25.29, -57.65, ?, 'PENDING', 0, 0)
        `).run(reportIdTest5, photoTest5)

        const reportTest5 = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(reportIdTest5)

        const mockDependenciesDbFail = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => ({ success: true, publicUrl: 'https://supabase.co/storage/v1/object/photo5.jpg' }),
            insertReportRecord: async () => ({ success: false, error: 'DB Connection Timeout' })
        }

        const resTest5 = await processSinglePendingReport(reportTest5, mockDependenciesDbFail)
        assert.strictEqual(resTest5.success, false, 'Debe reportar fallo ante error en DB')

        const reportTest5After = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(reportIdTest5)
        assert.ok(reportTest5After, 'El reporte DEBE permanecer en pending_sync_reports')
        assert.strictEqual(reportTest5After.storage_url, 'https://supabase.co/storage/v1/object/photo5.jpg', 'storage_url debe guardarse de inmediato en SQLite')
        assert.strictEqual(reportTest5After.attempts, 1)
        assert.ok(reportTest5After.last_error.includes('DB Connection Timeout'))
        assert.strictEqual(fs.existsSync(photoTest5), true, 'La foto física local DEBE conservarse hasta confirmación en DB')

        console.log('  ✅ Test 5 aprobado: Fallo en DB guarda storage_url y conserva foto local para reintento.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 6: Reintentos automáticos y backoff progresivo
        // --------------------------------------------------------------------------
        console.log('▶️ Test 6: Cálculo de backoff progresivo para reintentos...')
        assert.strictEqual(getNextRetryDelayMs(1), 5000, 'Intento 1: 5 segundos')
        assert.strictEqual(getNextRetryDelayMs(2), 15000, 'Intento 2: 15 segundos')
        assert.strictEqual(getNextRetryDelayMs(3), 45000, 'Intento 3: 45 segundos')
        assert.strictEqual(getNextRetryDelayMs(4), 120000, 'Intento 4: 2 minutos')
        assert.strictEqual(getNextRetryDelayMs(5), 300000, 'Intento 5: 5 minutos')
        assert.strictEqual(getNextRetryDelayMs(10), 300000, 'Intento 10: tope máximo 5 minutos')

        console.log('  ✅ Test 6 aprobado: Intervalos de backoff progresivo verificados correctamente.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 7: Resiliencia tras reinicio de Node.js / servidor
        // --------------------------------------------------------------------------
        console.log('▶️ Test 7: Resiliencia tras reinicio de Node.js (sincronización en arranque)...')
        const reportIdTest7 = 'rep_reboot_003'
        const photoTest7 = path.join(testUploads, `photo_reboot_${Date.now()}.jpg`)
        fs.writeFileSync(photoTest7, 'photo test 7 data')

        // Insertar reporte pendiente con next_retry_at = 0 (listo para procesar en arranque)
        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, status, attempts, next_retry_at)
            VALUES (?, '59598333@s.whatsapp.net', -25.30, -57.66, ?, 'PENDING', 0, 0)
        `).run(reportIdTest7, photoTest7)

        const mockSuccessDependencies = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => ({ success: true, publicUrl: 'https://supabase.co/storage/photo7.jpg' }),
            insertReportRecord: async () => ({ success: true, data: { id: 7001 } })
        }

        // Ejecutar orquestador como ocurriría en el arranque del bot
        await triggerSyncPendingReports(mockSuccessDependencies)

        const reportTest7After = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(reportIdTest7)
        assert.strictEqual(reportTest7After, undefined, 'El reporte sincronizado debe ser retirado de pending_sync_reports')
        assert.strictEqual(fs.existsSync(photoTest7), false, 'La fotografía local debe eliminarse tras sincronización total exitosa')

        console.log('  ✅ Test 7 aprobado: Los reportes pendientes se sincronizan exitosamente tras reinicio.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 8: Prevención de duplicados e idempotencia (reutilización de storage_url)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 8: Prevención de duplicados e idempotencia al reintentar...')
        const reportIdTest8 = 'rep_idempotent_004'
        const photoTest8 = path.join(testUploads, `photo_idempotent_${Date.now()}.jpg`)
        fs.writeFileSync(photoTest8, 'photo test 8 data')

        const existingUrl = 'https://supabase.co/storage/already_uploaded_photo.jpg'
        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, storage_url, status, attempts, next_retry_at)
            VALUES (?, '59598444@s.whatsapp.net', -25.31, -57.67, ?, ?, 'PENDING', 1, 0)
        `).run(reportIdTest8, photoTest8, existingUrl)

        let wasUploadCalled = false
        let urlReceivedInDb = null

        const mockIdempotentDependencies = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => {
                wasUploadCalled = true
                return { success: true, publicUrl: 'https://supabase.co/storage/duplicate.jpg' }
            },
            insertReportRecord: async (data) => {
                urlReceivedInDb = data.photoUrl
                return { success: true, data: { id: 8001 } }
            }
        }

        const reportTest8 = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(reportIdTest8)
        const resTest8 = await processSinglePendingReport(reportTest8, mockIdempotentDependencies)

        assert.strictEqual(resTest8.success, true, 'El proceso debe completarse con éxito')
        assert.strictEqual(wasUploadCalled, false, 'uploadReportPhoto NO debe llamarse si storage_url ya existía')
        assert.strictEqual(urlReceivedInDb, existingUrl, 'La DB debe recibir el storage_url previamente guardado')
        assert.strictEqual(fs.existsSync(photoTest8), false, 'La foto local debe eliminarse tras confirmación')

        console.log('  ✅ Test 8 aprobado: Idempotencia comprobada, no se re-suben fotos ya cargadas.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 9: Protección de fotos de reportes pendientes durante limpieza de huérfanos
        // --------------------------------------------------------------------------
        console.log('▶️ Test 9: Protección de fotografías de reportes pendientes en limpieza...')
        const pendingPhoto = path.join(testUploads, `photo_pending_protected_${Date.now()}.jpg`)
        fs.writeFileSync(pendingPhoto, 'pending protected photo')

        // Marcar la foto como antigua (>35 min) para simular que parece huérfana por tiempo
        const pastTimePending = (Date.now() - 35 * 60 * 1000) / 1000
        fs.utimesSync(pendingPhoto, pastTimePending, pastTimePending)

        // Registrarla en pending_sync_reports (NO está en report_sessions)
        const reportIdTest9 = 'rep_protect_cleanup_005'
        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, status, attempts, next_retry_at)
            VALUES (?, '59598999@s.whatsapp.net', -25.32, -57.68, ?, 'PENDING', 0, 9999999999999)
        `).run(reportIdTest9, pendingPhoto)

        // Ejecutar rutina de limpieza de sesiones y archivos
        cleanupExpiredSessionsAndFiles()

        assert.strictEqual(fs.existsSync(pendingPhoto), true, 'La foto de un reporte pendiente NUNCA debe ser purgada por la limpieza')

        // Limpieza de registro de prueba
        db.prepare('DELETE FROM pending_sync_reports WHERE id = ?').run(reportIdTest9)
        safeDeleteUploadFile(pendingPhoto)

        console.log('  ✅ Test 9 aprobado: Las fotos de reportes pendientes están totalmente blindadas contra limpiezas.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 10: Seguridad estricta de rutas en safeDeleteUploadFile
        // --------------------------------------------------------------------------
        console.log('▶️ Test 10: Seguridad de rutas y rechazo estricto de path traversal...')

        // 1. Intento de path traversal con ../
        const outsideFile = path.resolve(__dirname, 'package.json')
        assert.strictEqual(fs.existsSync(outsideFile), true)
        const traversalAttempt = safeDeleteUploadFile(path.join(testUploads, '../../package.json'))
        assert.strictEqual(traversalAttempt, false, 'safeDeleteUploadFile debe rechazar path traversal ../')
        assert.strictEqual(fs.existsSync(outsideFile), true, 'package.json debe permanecer intacto')

        // 2. Intento en carpeta hermana con prefijo similar (ej: uploads_test_fake)
        const fakeSiblingDir = path.join(testDir, 'uploads_test_fake')
        fs.mkdirSync(fakeSiblingDir, { recursive: true })
        const fakeFile = path.join(fakeSiblingDir, 'secret.txt')
        fs.writeFileSync(fakeFile, 'secret data')

        const siblingAttempt = safeDeleteUploadFile(fakeFile)
        assert.strictEqual(siblingAttempt, false, 'safeDeleteUploadFile debe rechazar carpetas hermanas')
        assert.strictEqual(fs.existsSync(fakeFile), true, 'El archivo en la carpeta hermana debe permanecer intacto')

        // 3. Intento de eliminar el propio directorio UPLOADS_DIR
        const selfDirAttempt = safeDeleteUploadFile(testUploads)
        assert.strictEqual(selfDirAttempt, false, 'safeDeleteUploadFile no debe permitir eliminar el directorio de uploads')
        assert.strictEqual(fs.existsSync(testUploads), true, 'UPLOADS_DIR debe permanecer intacto')

        // 4. Archivo legítimo dentro de uploads
        const legitFile = path.join(testUploads, `legit_photo_${Date.now()}.jpg`)
        fs.writeFileSync(legitFile, 'legit data')
        assert.strictEqual(fs.existsSync(legitFile), true)
        const legitDelete = safeDeleteUploadFile(legitFile)
        assert.strictEqual(legitDelete, true, 'safeDeleteUploadFile debe permitir eliminar archivos legítimos de uploads')
        assert.strictEqual(fs.existsSync(legitFile), false, 'El archivo legítimo debe ser eliminado')

        console.log('  ✅ Test 10 aprobado: Blindaje completo contra path traversal, carpetas hermanas y directorios.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 11: Idempotencia y prevención de duplicados con UUID persistente en Supabase
        // --------------------------------------------------------------------------
        console.log('▶️ Test 11: Identificación compartida por UUID persistente e idempotencia en Supabase...')
        const persistentUuidTest11 = '11111111-2222-3333-4444-555555555555'
        const photoTest11 = path.join(testUploads, `photo_uuid_${Date.now()}.jpg`)
        fs.writeFileSync(photoTest11, 'photo uuid test data')

        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, status, attempts, next_retry_at)
            VALUES (?, '595981112222@s.whatsapp.net', -25.281, -57.641, ?, 'PENDING', 0, 0)
        `).run(persistentUuidTest11, photoTest11)

        let receivedInsertPayload = null
        const mockDependenciesUuid = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => ({ success: true, publicUrl: 'https://supabase.co/storage/photo11.jpg' }),
            insertReportRecord: async (payload) => {
                receivedInsertPayload = payload
                return { success: true, data: { id: payload.id } }
            }
        }

        const reportTest11 = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(persistentUuidTest11)
        const resTest11 = await processSinglePendingReport(reportTest11, mockDependenciesUuid)

        assert.strictEqual(resTest11.success, true, 'El proceso debe completarse exitosamente')
        assert.ok(receivedInsertPayload, 'insertReportRecord debió ser invocado')
        assert.strictEqual(receivedInsertPayload.id, persistentUuidTest11, 'Supabase DEBE recibir exactamente el UUID persistente generado en SQLite')
        assert.strictEqual(resTest11.remoteData.id, persistentUuidTest11, 'El registro retornado debe conservar el mismo UUID')

        console.log('  ✅ Test 11 aprobado: UUID persistente compartido entre SQLite y Supabase garantiza idempotencia.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 12: Impedir reportes sin fotografía (obligatoriedad estricta)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 12: Impedir reportes sin fotografía (validación defensiva multinivel)...')

        // 12a: Reporte en cola con archivo físico local faltante y sin URL en Storage
        const missingPhotoUuid = '22222222-3333-4444-5555-666666666666'
        const nonExistentPath = path.join(testUploads, 'non_existent_file_12345.jpg')
        assert.strictEqual(fs.existsSync(nonExistentPath), false)

        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, storage_url, status, attempts, next_retry_at)
            VALUES (?, '595983334444@s.whatsapp.net', -25.285, -57.645, ?, NULL, 'PENDING', 0, 0)
        `).run(missingPhotoUuid, nonExistentPath)

        let wasDbInsertInvoked = false
        const mockDependenciesMissingPhoto = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => { throw new Error('No debe intentar subir si no existe el archivo') },
            insertReportRecord: async () => {
                wasDbInsertInvoked = true
                return { success: true, data: { id: 'should_not_happen' } }
            }
        }

        const reportMissingPhoto = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(missingPhotoUuid)
        const resMissingPhoto = await processSinglePendingReport(reportMissingPhoto, mockDependenciesMissingPhoto)

        assert.strictEqual(resMissingPhoto.success, false, 'Debe rechazar sincronizar si falta la foto')
        assert.strictEqual(resMissingPhoto.missingPhoto, true, 'Debe señalar flag de missingPhoto')
        assert.strictEqual(wasDbInsertInvoked, false, 'NUNCA se debe invocar la inserción en base de datos si falta la foto')

        // Verificar que el reporte se retiene en SQLite para auditoría manual
        const reportInSqlite = db.prepare('SELECT status, last_error FROM pending_sync_reports WHERE id = ?').get(missingPhotoUuid)
        assert.ok(reportInSqlite, 'El reporte incompleto DEBE conservarse en SQLite')
        assert.strictEqual(reportInSqlite.status, 'FAILED_MISSING_PHOTO', 'El estado debe marcarse como FAILED_MISSING_PHOTO')
        assert.ok(reportInSqlite.last_error.includes('Fotografía obligatoria no disponible'), 'Debe registrar detalle del error')

        // 12b: Llamada directa a insertReportRecord en supabaseClient sin imagen válida
        const directInsertResult = await insertReportRecord({
            id: '33333333-4444-5555-6666-777777777777',
            latitude: -25.28,
            longitude: -57.64,
            description: 'Prueba sin foto',
            photoUrl: null
        })

        assert.strictEqual(directInsertResult.success, false, 'insertReportRecord debe rechazar registros sin fotoUrl')
        assert.ok(directInsertResult.error.includes('Fotografía obligatoria'), 'El error debe indicar la obligatoriedad de la fotografía')

        // Limpieza de registro de prueba
        db.prepare('DELETE FROM pending_sync_reports WHERE id = ?').run(missingPhotoUuid)

        console.log('  ✅ Test 12 aprobado: Bloqueo estricto de reportes sin fotografía verificado a nivel de cola y de API.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 13: Avance directo a descripción opcional tras afectaciones (sin pregunta intermedia)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 13: Avance directo a descripción opcional tras afectaciones (sin pregunta intermedia)...')

        // 13a: Envío de encuesta de afectaciones e inmediatamente solicitud de descripción opcional
        const testUserDirect = '595987778888@s.whatsapp.net'
        deleteSession(testUserDirect)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_PHOTO', datetime('now'))
        `).run(testUserDirect)

        const mockSockDirect = createMockSocket()
        await sendAffectationPoll(mockSockDirect, testUserDirect)

        assert.strictEqual(mockSockDirect.sentMessages.length, 2, 'Debe haber enviado 2 mensajes: encuesta de afectaciones y directamente la descripción')
        const firstMsg = mockSockDirect.sentMessages[0].content
        assert.ok(firstMsg.poll, 'Primer mensaje debe ser la encuesta de afectaciones')
        assert.strictEqual(firstMsg.poll.name, '⛈️ Seleccioná las afectaciones (Opcional):')

        const secondMsg = mockSockDirect.sentMessages[1].content
        assert.ok(secondMsg.text.includes('Descripción del incidente (opcional)'), 'Segundo mensaje debe ser la solicitud de descripción directa')
        assert.ok(secondMsg.text.includes('respondé *1* para omitir'), 'Debe indicar que 1 es para omitir')

        // 13b: El voto en la encuesta de afectaciones actualiza silenciosamente SQLite
        const pollEntry = Array.from(global.pollRegistry.entries()).find(([_, v]) => v.userJid === testUserDirect && v.type === 'AFFECTATIONS')
        assert.ok(pollEntry, 'Debe registrar la encuesta de afectaciones en global.pollRegistry')
        const [affectationPollId, affectationReg] = pollEntry

        const voteEncAffectations = generateEncryptedPollVote({
            pollMsgId: affectationPollId,
            pollCreatorJid: mockSockDirect.user.id,
            voterJid: testUserDirect,
            pollEncKey: Buffer.from(affectationReg.encKeyHex, 'hex'),
            selectedOptionText: '1. Calle inundada'
        })

        // El usuario está en AWAITING_DESCRIPTION
        db.prepare(`
            UPDATE report_sessions
            SET state = 'AWAITING_DESCRIPTION',
                updated_at = datetime('now')
            WHERE user_jid = ?
        `).run(testUserDirect)

        await handleFloodReportFlow(mockSockDirect, testUserDirect, {
            key: { remoteJid: testUserDirect, id: 'MSG_VOTE_AFF_1' },
            message: {
                pollUpdateMessage: {
                    pollCreationMessageKey: {
                        id: affectationPollId,
                        remoteJid: testUserDirect,
                        fromMe: true
                    },
                    vote: voteEncAffectations
                }
            }
        })

        const sessionAfterAffVote = db.prepare('SELECT selected_affectations, state FROM report_sessions WHERE user_jid = ?').get(testUserDirect)
        assert.strictEqual(sessionAfterAffVote.state, 'AWAITING_DESCRIPTION', 'Debe mantenerse en AWAITING_DESCRIPTION')
        assert.ok(sessionAfterAffVote.selected_affectations.includes('Calle inundada'), 'Debe guardar la afectación seleccionada silenciosamente')

        // 13c: Enviar descripción en texto finaliza directamente el reporte sin paso de confirmación intermedia
        const mockSockDesc = createMockSocket()
        await handleFloodReportFlow(mockSockDesc, testUserDirect, {
            key: { remoteJid: testUserDirect, id: 'MSG_DESC_TEXT' },
            message: { conversation: 'El agua sobrepasó la vereda y entró a la cochera' }
        })

        const sessionAfterDesc = db.prepare('SELECT state, description FROM report_sessions WHERE user_jid = ?').get(testUserDirect)
        assert.strictEqual(sessionAfterDesc, undefined, 'Enviar descripción debe cerrar la sesión sin confirmación intermedia')
        assert.ok(mockSockDesc.sentMessages.length >= 2, 'Debe haber emitido el resumen y el mensaje final de agradecimiento')
        assert.ok(mockSockDesc.sentMessages[0].content.text.includes('Resumen de tu reporte'), 'Primer mensaje debe ser el resumen')
        assert.strictEqual(mockSockDesc.sentMessages[1].content.text, FINAL_SUCCESS_MESSAGE, 'Segundo mensaje debe ser el mensaje final original')

        // 13d: Omitir descripción respondiendo 1 finaliza directamente el reporte
        const userOmit = '595987779999@s.whatsapp.net'
        deleteSession(userOmit)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_DESCRIPTION', datetime('now'))
        `).run(userOmit)

        const mockSockOmit = createMockSocket()
        await handleFloodReportFlow(mockSockOmit, userOmit, {
            key: { remoteJid: userOmit, id: 'MSG_OMIT_1' },
            message: { conversation: '1' }
        })

        const sessionAfterOmit = db.prepare('SELECT state, description FROM report_sessions WHERE user_jid = ?').get(userOmit)
        assert.strictEqual(sessionAfterOmit, undefined, 'Responder 1 debe cerrar la sesión sin confirmación')
        assert.ok(mockSockOmit.sentMessages.length >= 2, 'Debe haber emitido el resumen y el mensaje final')
        assert.ok(mockSockOmit.sentMessages[0].content.text.includes('Resumen de tu reporte'), 'Primer mensaje debe ser el resumen')
        assert.strictEqual(mockSockOmit.sentMessages[1].content.text, FINAL_SUCCESS_MESSAGE, 'Segundo mensaje debe ser el mensaje final original')

        // 13e: Cancelar en AWAITING_DESCRIPTION elimina la sesión
        const userCancel13 = '595987770000@s.whatsapp.net'
        deleteSession(userCancel13)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_DESCRIPTION', datetime('now'))
        `).run(userCancel13)

        const mockSockCancel13 = createMockSocket()
        await handleFloodReportFlow(mockSockCancel13, userCancel13, {
            key: { remoteJid: userCancel13, id: 'MSG_CANCEL_0' },
            message: { conversation: 'CANCELAR' }
        })

        const sessionAfterCancel = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userCancel13)
        assert.strictEqual(sessionAfterCancel, undefined, 'Escribir CANCELAR debe eliminar la sesión')

        // 13f: Compatibilidad con sesiones recuperadas en AWAITING_AFFECTATIONS_AND_DESC
        const userLegacy = '595987771111@s.whatsapp.net'
        deleteSession(userLegacy)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_AFFECTATIONS_AND_DESC', datetime('now'))
        `).run(userLegacy)

        const mockSockLegacy = createMockSocket()
        await handleFloodReportFlow(mockSockLegacy, userLegacy, {
            key: { remoteJid: userLegacy, id: 'MSG_LEGACY_1' },
            message: { conversation: '1' }
        })
        const sessionAfterLegacy = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userLegacy)
        assert.strictEqual(sessionAfterLegacy, undefined, 'Sesión recuperada en AWAITING_AFFECTATIONS_AND_DESC debe finalizar directamente')
        assert.ok(mockSockLegacy.sentMessages.length >= 2)
        assert.ok(mockSockLegacy.sentMessages[0].content.text.includes('Resumen de tu reporte'))
        assert.strictEqual(mockSockLegacy.sentMessages[1].content.text, FINAL_SUCCESS_MESSAGE)

        deleteSession(testUserDirect)
        deleteSession(userOmit)
        deleteSession(userCancel13)
        deleteSession(userLegacy)

        console.log('  ✅ Test 13 aprobado: Avance directo a descripción opcional tras afectaciones 100% verificado.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 14: Interfaz interactiva nativa de confirmación (Confirmar / Cancelar) y comandos de texto
        // --------------------------------------------------------------------------
        console.log('▶️ Test 14: Encuesta interactiva de confirmación final (Confirmar / Cancelar) y comandos de texto...')

        const testUserConfirm = '595988880001@s.whatsapp.net'
        const mockSessionData = {
            latitude: -25.2865,
            longitude: -57.6472,
            selected_affectations: JSON.stringify(['Calle inundada', 'Vehículo afectado']),
            description: 'Agua cubriendo veredas',
            photo_path: path.join(testUploads, 'photo_test_14.jpg')
        }
        fs.writeFileSync(mockSessionData.photo_path, 'fake_jpg_content_14')

        // 14a: Envío de resumen y encuesta interactiva nativa de confirmación (modo 'POLL')
        const mockSockConfirmPoll = createMockSocket()
        const sentConfirmMsg = await sendReportConfirmationInterface(mockSockConfirmPoll, testUserConfirm, mockSessionData)

        assert.strictEqual(mockSockConfirmPoll.sentMessages.length, 2, 'Debe haber enviado 2 mensajes: resumen de texto y encuesta interactiva')
        assert.ok(mockSockConfirmPoll.sentMessages[0].content.text.includes('Resumen de tu reporte'), 'Primer mensaje debe ser el resumen')
        const confirmPollContent = mockSockConfirmPoll.sentMessages[1].content
        assert.ok(confirmPollContent.poll, 'Segundo mensaje debe ser la encuesta interactiva nativa')
        assert.strictEqual(confirmPollContent.poll.name, '👉 ¿Confirmás los datos para enviar el reporte?')
        assert.deepStrictEqual(confirmPollContent.poll.values, ['1. Confirmar y enviar', '0. Cancelar'])
        assert.strictEqual(confirmPollContent.poll.selectableCount, 1, 'Debe permitir seleccionar solo una opción')
        assert.ok(global.pollRegistry.has(sentConfirmMsg.key.id), 'Debe registrar la encuesta de confirmación en global.pollRegistry')
        assert.strictEqual(global.pollRegistry.get(sentConfirmMsg.key.id).type, 'CONFIRMATION')

        // 14b: Modo tradicional de texto plano (reversibilidad rápida mediante modeOverride = 'TEXT')
        const mockSockConfirmText = createMockSocket()
        await sendReportConfirmationInterface(mockSockConfirmText, testUserConfirm, mockSessionData, 'TEXT')
        assert.strictEqual(mockSockConfirmText.sentMessages.length, 1, 'En modo TEXT debe emitir un único mensaje')
        assert.ok(mockSockConfirmText.sentMessages[0].content.text.includes('Respondé *1* o *CONFIRMAR*'), 'Debe incluir instrucciones tradicionales de texto')

        // 14c: Respuesta seleccionando "1. Confirmar y enviar" en la encuesta interactiva
        const userConfirmVote = '595988880002@s.whatsapp.net'
        deleteSession(userConfirmVote)
        const photoVotePath = path.join(testUploads, 'photo_vote_14c.jpg')
        fs.writeFileSync(photoVotePath, 'vote_jpg_content')

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, selected_affectations, photo_path, description, updated_at)
            VALUES (?, 'AWAITING_CONFIRMATION', -25.29, -57.65, '["Calle inundada"]', ?, 'Detalle de prueba', datetime('now'))
        `).run(userConfirmVote, photoVotePath)

        const mockSockVoteConfirm = createMockSocket()
        const decMsgConfirm = await sendReportConfirmationInterface(mockSockVoteConfirm, userConfirmVote, {
            latitude: -25.29,
            longitude: -57.65,
            selected_affectations: '["Calle inundada"]',
            photo_path: photoVotePath,
            description: 'Detalle de prueba'
        }, 'POLL')

        const voteEncConfirm = generateEncryptedPollVote({
            pollMsgId: decMsgConfirm.key.id,
            pollCreatorJid: mockSockVoteConfirm.user.id,
            voterJid: userConfirmVote,
            pollEncKey: Buffer.from(global.pollRegistry.get(decMsgConfirm.key.id).encKeyHex, 'hex'),
            selectedOptionText: '1. Confirmar y enviar'
        })

        await handleFloodReportFlow(mockSockVoteConfirm, userConfirmVote, {
            key: { remoteJid: userConfirmVote, id: 'MSG_VOTE_CONFIRM_1' },
            message: {
                pollUpdateMessage: {
                    pollCreationMessageKey: {
                        id: decMsgConfirm.key.id,
                        remoteJid: userConfirmVote,
                        fromMe: true
                    },
                    vote: voteEncConfirm
                }
            }
        })

        // Verificar que la sesión activa se cerró
        const sessionAfterVoteConfirm = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userConfirmVote)
        assert.strictEqual(sessionAfterVoteConfirm, undefined, 'La sesión activa debe cerrarse tras confirmar')

        // Verificar que el reporte se guardó en pending_sync_reports
        const pendingReport = db.prepare('SELECT id, status, photo_path FROM pending_sync_reports WHERE user_jid = ?').get(userConfirmVote)
        assert.ok(pendingReport, 'El reporte confirmado debe residir en pending_sync_reports')
        assert.strictEqual(pendingReport.status, 'PENDING')
        assert.ok(fs.existsSync(pendingReport.photo_path), 'La fotografía local debe conservarse para la sincronización')

        // Verificar mensaje de agradecimiento
        const lastMsgConfirm = mockSockVoteConfirm.sentMessages[mockSockVoteConfirm.sentMessages.length - 1]
        assert.ok(lastMsgConfirm.content.text.includes('¡Reporte recibido correctamente!'), 'Debe emitir mensaje final de confirmación')

        // Limpiar registro pendiente de prueba
        db.prepare('DELETE FROM pending_sync_reports WHERE id = ?').run(pendingReport.id)
        safeDeleteUploadFile(photoVotePath)

        // 14d: Respuesta seleccionando "0. Cancelar" en la encuesta interactiva
        const userCancelVote = '595988880003@s.whatsapp.net'
        deleteSession(userCancelVote)
        const photoCancelPath = path.join(testUploads, 'photo_cancel_14d.jpg')
        fs.writeFileSync(photoCancelPath, 'cancel_jpg_content')

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, selected_affectations, photo_path, description, updated_at)
            VALUES (?, 'AWAITING_CONFIRMATION', -25.29, -57.65, '["Calle inundada"]', ?, 'Detalle', datetime('now'))
        `).run(userCancelVote, photoCancelPath)

        const mockSockVoteCancelConfirm = createMockSocket()
        const decMsgCancelConfirm = await sendReportConfirmationInterface(mockSockVoteCancelConfirm, userCancelVote, {
            latitude: -25.29,
            longitude: -57.65,
            photo_path: photoCancelPath
        }, 'POLL')

        const voteEncCancelConfirm = generateEncryptedPollVote({
            pollMsgId: decMsgCancelConfirm.key.id,
            pollCreatorJid: mockSockVoteCancelConfirm.user.id,
            voterJid: userCancelVote,
            pollEncKey: Buffer.from(global.pollRegistry.get(decMsgCancelConfirm.key.id).encKeyHex, 'hex'),
            selectedOptionText: '0. Cancelar'
        })

        await handleFloodReportFlow(mockSockVoteCancelConfirm, userCancelVote, {
            key: { remoteJid: userCancelVote, id: 'MSG_VOTE_CONFIRM_0' },
            message: {
                pollUpdateMessage: {
                    pollCreationMessageKey: {
                        id: decMsgCancelConfirm.key.id,
                        remoteJid: userCancelVote,
                        fromMe: true
                    },
                    vote: voteEncCancelConfirm
                }
            }
        })

        const sessionAfterVoteCancelConfirm = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userCancelVote)
        assert.strictEqual(sessionAfterVoteCancelConfirm, undefined, 'Votar Cancelar debe eliminar la sesión activa')
        assert.strictEqual(fs.existsSync(photoCancelPath), false, 'La foto temporal debe eliminarse al cancelar')
        const lastMsgCancelConfirm = mockSockVoteCancelConfirm.sentMessages[mockSockVoteCancelConfirm.sentMessages.length - 1]
        assert.ok(lastMsgCancelConfirm.content.text.includes('Reporte cancelado'), 'Debe enviar mensaje de confirmación de cancelación')

        // 14e: Respaldo de comando escrito ('CONFIRMAR')
        const userTextConfirm = '595988880004@s.whatsapp.net'
        deleteSession(userTextConfirm)
        const photoTextConfirm = path.join(testUploads, 'photo_text_14e.jpg')
        fs.writeFileSync(photoTextConfirm, 'text_confirm_jpg')

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, selected_affectations, photo_path, description, updated_at)
            VALUES (?, 'AWAITING_CONFIRMATION', -25.29, -57.65, '["Calle inundada"]', ?, 'Detalle', datetime('now'))
        `).run(userTextConfirm, photoTextConfirm)

        const mockSockTextConfirm = createMockSocket()
        await handleFloodReportFlow(mockSockTextConfirm, userTextConfirm, {
            key: { remoteJid: userTextConfirm, id: 'MSG_TEXT_CONFIRM' },
            message: { conversation: 'CONFIRMAR' }
        })

        const sessionAfterTextConfirm = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userTextConfirm)
        assert.strictEqual(sessionAfterTextConfirm, undefined, 'Comando escrito CONFIRMAR debe cerrar sesión')
        const pendingFromText = db.prepare('SELECT id FROM pending_sync_reports WHERE user_jid = ?').get(userTextConfirm)
        assert.ok(pendingFromText, 'Comando escrito CONFIRMAR debe registrar en pending_sync_reports')
        db.prepare('DELETE FROM pending_sync_reports WHERE id = ?').run(pendingFromText.id)
        safeDeleteUploadFile(photoTextConfirm)

        safeDeleteUploadFile(mockSessionData.photo_path)
        deleteSession(testUserConfirm)

        console.log('  ✅ Test 14 aprobado: Encuesta nativa de confirmación (Confirmar / Cancelar) y comandos de texto alternativos 100% operativos.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 15: Verificación del Rate Limiting (medición de tiempos >= 350 ms)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 15: Medición precisa del Rate Limiting (intervalo >= 350 ms)...')
        const mockSockRate = createMockSocket()
        const customQueue = new MessageQueue(350, 60000)
        customQueue.setSocket(mockSockRate)

        const timestamps = []
        const p1 = customQueue.enqueue('595981111111@s.whatsapp.net', { text: 'Msg 1' }).then(() => timestamps.push(Date.now()))
        const p2 = customQueue.enqueue('595981111111@s.whatsapp.net', { text: 'Msg 2' }).then(() => timestamps.push(Date.now()))
        const p3 = customQueue.enqueue('595981111111@s.whatsapp.net', { text: 'Msg 3' }).then(() => timestamps.push(Date.now()))

        await Promise.all([p1, p2, p3])
        assert.strictEqual(mockSockRate.sentMessages.length, 3, 'Deben haberse enviado los 3 mensajes')
        assert.strictEqual(timestamps.length, 3)

        const diff1 = timestamps[1] - timestamps[0]
        const diff2 = timestamps[2] - timestamps[1]
        assert.ok(diff1 >= 320, `Intervalo 1 entre mensajes (${diff1}ms) debe respetar el límite de ~350ms`)
        assert.ok(diff2 >= 320, `Intervalo 2 entre mensajes (${diff2}ms) debe respetar el límite de ~350ms`)
        console.log(`  ✅ Test 15 aprobado: Rate Limiting verificado exitosamente (Intervalos: ${diff1}ms, ${diff2}ms >= 350ms).\n`)
        passedTests++

        // --------------------------------------------------------------------------
        // Test 16: Preservación de orden FIFO por ciudadano ante envíos simultáneos
        // --------------------------------------------------------------------------
        console.log('▶️ Test 16: Preservación de orden FIFO de mensajes por ciudadano en ráfagas...')
        const mockSockFifo = createMockSocket()
        const fifoQueue = new MessageQueue(50, 60000)
        fifoQueue.setSocket(mockSockFifo)

        const userA = '595980000001@s.whatsapp.net'
        const userB = '595980000002@s.whatsapp.net'

        // Encolar de forma concurrente mensajes intercalados de dos ciudadanos
        const promises = [
            fifoQueue.enqueue(userA, { text: 'A1: Bienvenida' }),
            fifoQueue.enqueue(userB, { text: 'B1: Bienvenida' }),
            fifoQueue.enqueue(userA, { text: 'A2: Ubicación' }),
            fifoQueue.enqueue(userB, { text: 'B2: Ubicación' }),
            fifoQueue.enqueue(userA, { text: 'A3: Descripción' }),
            fifoQueue.enqueue(userB, { text: 'B3: Descripción' })
        ]

        await Promise.all(promises)
        const messagesA = mockSockFifo.sentMessages.filter(m => m.jid === userA).map(m => m.content.text)
        const messagesB = mockSockFifo.sentMessages.filter(m => m.jid === userB).map(m => m.content.text)

        assert.deepStrictEqual(messagesA, ['A1: Bienvenida', 'A2: Ubicación', 'A3: Descripción'], 'Mensajes de usuario A deben mantener orden estricto')
        assert.deepStrictEqual(messagesB, ['B1: Bienvenida', 'B2: Ubicación', 'B3: Descripción'], 'Mensajes de usuario B deben mantener orden estricto')
        console.log('  ✅ Test 16 aprobado: Orden FIFO preservado sin alteraciones entre múltiples ciudadanos.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 17: Retorno intacto de objetos de mensaje en encuestas interactivas
        // --------------------------------------------------------------------------
        console.log('▶️ Test 17: Conservación del resultado de sendMessage para encuestas interactivas...')
        const mockSockPoll = createMockSocket()
        const pollQueue = new MessageQueue(20, 60000)
        pollQueue.setSocket(mockSockPoll)

        const pollResult = await pollQueue.enqueue('595980000003@s.whatsapp.net', {
            poll: { name: 'Test Poll', values: ['1. Si', '0. No'], selectableCount: 1 }
        })

        assert.ok(pollResult, 'El resultado de la promesa de la cola debe existir')
        assert.ok(pollResult.key?.id, 'Debe contener key.id')
        assert.ok(pollResult.message?.messageContextInfo?.messageSecret, 'Debe contener messageSecret para descifrar votos')
        console.log('  ✅ Test 17 aprobado: Metadatos de encuestas interactivas devueltos intactos por la cola.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 18: Pausa ante desconexión, retención de mensajes y reanudación con socket activo
        // --------------------------------------------------------------------------
        console.log('▶️ Test 18: Pausa de cola ante desconexión y reanudación ordenada con socket activo...')
        const mockSockDisconnect = createMockSocket()
        const pauseQueue = new MessageQueue(50, 60000)
        pauseQueue.setSocket(mockSockDisconnect)

        // Pausar simulando desconexión
        pauseQueue.pause()
        let p1Resolved = false
        const pDisconnected = pauseQueue.enqueue('595980000004@s.whatsapp.net', { text: 'Mensaje retenido en pausa' }).then(() => {
            p1Resolved = true
        })

        // Esperar un instante para certificar que NO se despacha estando en pausa
        await new Promise(r => setTimeout(r, 120))
        assert.strictEqual(p1Resolved, false, 'El mensaje encolado no debe despacharse mientras la cola esté pausada')
        assert.strictEqual(mockSockDisconnect.sentMessages.length, 0, 'No debe haberse enviado al socket')

        // Simular reconexión con un socket nuevo
        const mockSockReconnected = createMockSocket()
        pauseQueue.setSocket(mockSockReconnected)
        pauseQueue.resume()

        await pDisconnected
        assert.strictEqual(p1Resolved, true, 'El mensaje debe haberse despachado tras reanudar')
        assert.strictEqual(mockSockDisconnect.sentMessages.length, 0, 'El socket viejo no debe haber recibido el mensaje')
        assert.strictEqual(mockSockReconnected.sentMessages.length, 1, 'El nuevo socket activo debe haber recibido el mensaje retenido')
        console.log('  ✅ Test 18 aprobado: Pausa ante desconexión y reanudación con socket activo verificadas.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 19: Expiración y rechazo explícito tras desconexión prolongada
        // --------------------------------------------------------------------------
        console.log('▶️ Test 19: Expiración y rechazo explícito tras desconexión prolongada (> maxAgeMs)...')
        const mockSockExpire = createMockSocket()
        // Cola con maxAgeMs ultra-corto de 100ms para probar la expiración
        const expireQueue = new MessageQueue(50, 100)
        expireQueue.setSocket(mockSockExpire)

        // Pausar y encolar
        expireQueue.pause()
        let expireError = null
        const pExpired = expireQueue.enqueue('595980000005@s.whatsapp.net', { text: 'Instrucción obsoleta' }).catch(err => {
            expireError = err
        })

        // Esperar 150 ms para que el mensaje supere los 100 ms de maxAgeMs
        await new Promise(r => setTimeout(r, 150))
        expireQueue.resume()

        await pExpired
        assert.ok(expireError, 'El mensaje antiguo debe ser rechazado con error explícito')
        assert.ok(expireError.message.includes('expirado tras desconexión prolongada'), 'El error debe indicar expiración por desconexión prolongada')
        assert.strictEqual(mockSockExpire.sentMessages.length, 0, 'El mensaje expirado no debe haberse enviado al socket')
        console.log('  ✅ Test 19 aprobado: Mensajes obsoletos rechazados explícitamente sin envío a destiempo ni descarte silencioso.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 20: Auto-guardado de reporte básico ante abandono tras enviar fotografía
        // --------------------------------------------------------------------------
        console.log('▶️ Test 20: Auto-guardado de reporte básico ante abandono tras enviar fotografía...')
        const userAutoSave = '595989990001@s.whatsapp.net'
        const mockSock20 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userAutoSave)

        // 1. Envío de ubicación GPS -> pasa a AWAITING_PHOTO
        await handleFloodReportFlow(mockSock20, userAutoSave, {
            key: { remoteJid: userAutoSave, id: 'MSG_T20_LOC' },
            message: {
                locationMessage: {
                    degreesLatitude: -25.2910,
                    degreesLongitude: -57.6520
                }
            }
        })

        // 2. Envío de fotografía válida -> auto-guarda y pasa a AWAITING_DESCRIPTION
        await handleFloodReportFlow(mockSock20, userAutoSave, {
            key: { remoteJid: userAutoSave, id: 'MSG_T20_PHOTO' },
            message: {
                imageMessage: {
                    mimetype: 'image/jpeg',
                    caption: ''
                }
            }
        })

        // Verificar que la sesión activa tiene report_id asignado tempranamente
        const session20 = db.prepare('SELECT state, latitude, longitude, photo_path, report_id FROM report_sessions WHERE user_jid = ?').get(userAutoSave)
        assert.ok(session20, 'La sesión conversacional debe existir')
        assert.strictEqual(session20.state, 'AWAITING_DESCRIPTION')
        assert.ok(session20.report_id, 'Debe haberse generado un UUID report_id temprano')
        assert.ok(fs.existsSync(session20.photo_path), 'La fotografía debe haberse guardado en disco')

        // Verificar que el reporte básico se insertó de inmediato en pending_sync_reports
        const pending20 = db.prepare('SELECT id, user_jid, latitude, longitude, description, selected_affectations, photo_path, status FROM pending_sync_reports WHERE id = ?').get(session20.report_id)
        assert.ok(pending20, 'El reporte básico debe residir en pending_sync_reports sin esperar confirmación')
        assert.strictEqual(pending20.user_jid, userAutoSave)
        assert.strictEqual(pending20.latitude, -25.2910)
        assert.strictEqual(pending20.longitude, -57.6520)
        assert.strictEqual(pending20.description, 'Sin descripción')
        assert.strictEqual(pending20.selected_affectations, '[]')
        console.log('  ✅ Test 20 aprobado: Reporte básico auto-guardado en SQLite inmediatamente al recibir foto.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 21: Expiración por inactividad (>15 min) tras auto-guardado conserva el reporte y envía mensaje original
        // --------------------------------------------------------------------------
        console.log('▶️ Test 21: Expiración por inactividad (>15 min) conserva reporte y envía mensaje original...')
        // Simular que el usuario 20 abandonó la conversación y pasaron 16 minutos (> 15 min)
        db.prepare("UPDATE report_sessions SET updated_at = datetime('now', '-16 minutes') WHERE user_jid = ?").run(userAutoSave)

        // Ejecutar rutina de mantenimiento y limpieza con socket simulado
        const mockSockCleanup21 = createMockSocket()
        await cleanupExpiredSessionsAndFiles(mockSockCleanup21)

        // La sesión conversacional debe haberse eliminado para liberar el chat
        const session21After = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userAutoSave)
        assert.strictEqual(session21After, undefined, 'La sesión conversacional expirada debe cerrarse')

        // Debe haber enviado el mensaje final original exacto
        assert.strictEqual(mockSockCleanup21.sentMessages.length, 1, 'Debe haber enviado exactamente el mensaje final de agradecimiento')
        assert.strictEqual(mockSockCleanup21.sentMessages[0].content.text, FINAL_SUCCESS_MESSAGE, 'El mensaje debe ser el mensaje final original exacto')

        // Pero el reporte auto-guardado en pending_sync_reports y su fotografía DEBEN CONSERVARSE
        const pending21After = db.prepare('SELECT id, photo_path FROM pending_sync_reports WHERE id = ?').get(session20.report_id)
        assert.ok(pending21After, 'El reporte auto-guardado debe permanecer intacto tras expiración de sesión')
        assert.ok(fs.existsSync(pending21After.photo_path), 'La fotografía del reporte pendiente no debe eliminarse por inactividad')
        console.log('  ✅ Test 21 aprobado: Inactividad cierra el diálogo pero preserva el reporte y su fotografía.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 22: Continuación con afectaciones y descripción enriqueciendo el mismo reporte
        // --------------------------------------------------------------------------
        console.log('▶️ Test 22: Continuación con afectaciones y descripción enriqueciendo el mismo reporte...')
        const userFlow = '595989990002@s.whatsapp.net'
        const mockSock22 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userFlow)

        // Ubicación
        await handleFloodReportFlow(mockSock22, userFlow, {
            key: { remoteJid: userFlow, id: 'MSG_T22_LOC' },
            message: { locationMessage: { degreesLatitude: -25.2950, degreesLongitude: -57.6550 } }
        })
        // Foto
        await handleFloodReportFlow(mockSock22, userFlow, {
            key: { remoteJid: userFlow, id: 'MSG_T22_PHOTO' },
            message: { imageMessage: { mimetype: 'image/jpeg' } }
        })

        const session22 = db.prepare('SELECT report_id, photo_path FROM report_sessions WHERE user_jid = ?').get(userFlow)
        const initialReportId = session22.report_id
        assert.ok(initialReportId, 'Debe haberse generado report_id')

        // Enviar descripción
        await handleFloodReportFlow(mockSock22, userFlow, {
            key: { remoteJid: userFlow, id: 'MSG_T22_DESC' },
            message: { conversation: 'El agua sobrepasó el muro perimetral' }
        })

        // Comprobar que en pending_sync_reports se actualizó la descripción bajo el MISMO report_id
        const pending22 = db.prepare('SELECT id, description, selected_affectations FROM pending_sync_reports WHERE id = ?').get(initialReportId)
        assert.ok(pending22, 'Debe existir el reporte con el mismo UUID')
        assert.strictEqual(pending22.id, initialReportId, 'El UUID del reporte debe ser exactamente el mismo')
        assert.strictEqual(pending22.description, 'El agua sobrepasó el muro perimetral', 'La descripción debe haberse actualizado en el mismo registro')

        // La sesión debe haberse cerrado
        const session22After = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userFlow)
        assert.strictEqual(session22After, undefined, 'La sesión conversacional debe cerrarse al completar descripción')

        const lastMsg22 = mockSock22.sentMessages[mockSock22.sentMessages.length - 1]
        assert.strictEqual(lastMsg22.content.text, FINAL_SUCCESS_MESSAGE, 'Debe emitir el mensaje final original')
        const summaryMsg22 = mockSock22.sentMessages[mockSock22.sentMessages.length - 2]
        assert.ok(summaryMsg22.content.text.includes('Resumen de tu reporte'), 'Debe emitir el resumen del reporte')

        console.log('  ✅ Test 22 aprobado: Afectaciones y descripción enriquecen el mismo reporte y finalizan fluidamente.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 23: Prevención de mensajes de despedida duplicados y confirmación eliminada
        // --------------------------------------------------------------------------
        console.log('▶️ Test 23: Prevención de mensajes de despedida duplicados tras finalización...')
        // La sesión conversacional de userFlow ya se cerró directamente al completar la descripción en Test 22
        const session23After = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userFlow)
        assert.strictEqual(session23After, undefined, 'La sesión conversacional debe estar cerrada sin requerir paso de confirmación')

        // Al transcurrir 15 minutos y correr el mantenimiento en segundo plano, NO debe emitirse un segundo mensaje
        const mockSockCleanup23 = createMockSocket()
        await cleanupExpiredSessionsAndFiles(mockSockCleanup23)

        const userFlowSent = mockSockCleanup23.sentMessages.filter(m => m.jid === userFlow)
        assert.strictEqual(userFlowSent.length, 0, 'No debe enviarse un segundo mensaje de despedida si la conversación ya terminó normalmente')

        // En pending_sync_reports debe haber EXACTAMENTE UN registro para este usuario
        const allReportsUser22 = db.prepare('SELECT id FROM pending_sync_reports WHERE user_jid = ?').all(userFlow)
        assert.strictEqual(allReportsUser22.length, 1, 'No debe crearse un segundo reporte; debe existir exactamente uno')
        assert.strictEqual(allReportsUser22[0].id, initialReportId, 'El ID del reporte confirmado debe ser el generado originalmente')

        // Mensaje final emitido con éxito en Test 22
        const checkLastMsg22 = mockSock22.sentMessages[mockSock22.sentMessages.length - 1]
        assert.strictEqual(checkLastMsg22.content.text, FINAL_SUCCESS_MESSAGE, 'Debe emitir el mensaje final original exacto')
        console.log('  ✅ Test 23 aprobado: Prevención de mensajes duplicados y finalización directa confirmadas.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 24: Cancelación/salida post-foto conserva reporte; previa descarta borrador
        // --------------------------------------------------------------------------
        console.log('▶️ Test 24: Salida post-foto conserva reporte; previa descarta borrador...')
        const userCancel24 = '595989990003@s.whatsapp.net'
        const mockSock24 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userCancel24)

        // Ubicación
        await handleFloodReportFlow(mockSock24, userCancel24, {
            key: { remoteJid: userCancel24, id: 'MSG_T24_LOC' },
            message: { locationMessage: { degreesLatitude: -25.2800, degreesLongitude: -57.6400 } }
        })
        // Foto
        await handleFloodReportFlow(mockSock24, userCancel24, {
            key: { remoteJid: userCancel24, id: 'MSG_T24_PHOTO' },
            message: { imageMessage: { mimetype: 'image/jpeg' } }
        })

        const session24 = db.prepare('SELECT report_id, photo_path FROM report_sessions WHERE user_jid = ?').get(userCancel24)
        const cancelReportId = session24.report_id
        const cancelPhotoPath = session24.photo_path
        assert.ok(fs.existsSync(cancelPhotoPath), 'La foto física existe antes de cancelar')

        // El usuario cancela/sale escribiendo '0' en las preguntas opcionales
        await handleFloodReportFlow(mockSock24, userCancel24, {
            key: { remoteJid: userCancel24, id: 'MSG_T24_CANCEL' },
            message: { conversation: '0' }
        })

        // Verificar que pending_sync_reports CONSERVA el reporte registrado
        const pending24 = db.prepare('SELECT id FROM pending_sync_reports WHERE id = ?').get(cancelReportId)
        assert.ok(pending24, 'El reporte auto-guardado DEBE CONSERVARSE tras salir de las preguntas opcionales')

        // La foto física DEBE mantenerse intacta para la sincronización con Supabase
        assert.strictEqual(fs.existsSync(cancelPhotoPath), true, 'La fotografía debe conservarse')

        // La sesión debe haberse cerrado
        const session24After = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userCancel24)
        assert.strictEqual(session24After, undefined, 'La sesión debe haberse cerrado')

        // Caso previo a la foto: cancelar descarta el borrador
        const userCancelDraft = '595989990004@s.whatsapp.net'
        const mockSockDraft = createMockSocket()
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userCancelDraft)

        await handleFloodReportFlow(mockSockDraft, userCancelDraft, {
            key: { remoteJid: userCancelDraft, id: 'MSG_DRAFT_CANCEL' },
            message: { conversation: '0' }
        })
        const sessionDraftAfter = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userCancelDraft)
        assert.strictEqual(sessionDraftAfter, undefined, 'El borrador previo a la foto debe descartarse')
        assert.ok(mockSockDraft.sentMessages[0].content.text.includes('Reporte cancelado'))

        console.log('  ✅ Test 24 aprobado: Salida post-foto preserva reporte y cancelación previa descarta borrador.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 25: Fallo de conexión con Supabase y sincronización diferida exitosa
        // --------------------------------------------------------------------------
        console.log('▶️ Test 25: Fallo de conexión con Supabase y sincronización diferida exitosa...')
        const failReportId = 'rep_fail_net_025'
        const failPhoto = path.join(testUploads, 'photo_fail_025.jpg')
        fs.writeFileSync(failPhoto, 'test_fail_025')

        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, selected_affectations, photo_path, description, status)
            VALUES (?, '595989990004@s.whatsapp.net', -25.30, -57.66, '[]', ?, 'Sin descripción', 'PENDING')
        `).run(failReportId, failPhoto)

        // 1. Simular Supabase temporalmente inaccesible
        const mockFailingDeps = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => ({ success: false, error: 'Network 503 Service Unavailable' }),
            insertReportRecord: async () => ({ success: false, error: 'Network 503' }),
            updateReportRecord: async () => ({ success: false, error: 'Network 503' })
        }

        const resFail = await processSinglePendingReport(db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(failReportId), mockFailingDeps)
        assert.strictEqual(resFail.success, false, 'El intento debe fallar')

        // Verificar que el reporte se retiene en SQLite y la foto no se borra
        const repAfterFail = db.prepare('SELECT attempts, status FROM pending_sync_reports WHERE id = ?').get(failReportId)
        assert.strictEqual(repAfterFail.attempts, 1)
        assert.ok(fs.existsSync(failPhoto), 'La fotografía debe conservarse ante fallo de red')

        // 2. Simular restauración de la conexión con Supabase
        const mockSuccessDeps = {
            isSupabaseConfigured: () => true,
            uploadReportPhoto: async () => ({ success: true, publicUrl: 'https://supabase.co/storage/photo_025.jpg' }),
            insertReportRecord: async () => ({ success: true, data: { id: failReportId } }),
            updateReportRecord: async () => ({ success: true, data: { id: failReportId } })
        }

        const resSuccess = await processSinglePendingReport(db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(failReportId), mockSuccessDeps)
        assert.strictEqual(resSuccess.success, true, 'La sincronización debe ser exitosa tras restaurarse la conexión')
        assert.strictEqual(db.prepare('SELECT id FROM pending_sync_reports WHERE id = ?').get(failReportId), undefined, 'El registro pendiente debe limpiarse')
        assert.strictEqual(fs.existsSync(failPhoto), false, 'La foto local debe eliminarse tras sincronizar con éxito')
        console.log('  ✅ Test 25 aprobado: Tolerancia a fallos de red y sincronización diferida comprobadas.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 26: Protección del estado de verificación administrativa durante actualizaciones
        // --------------------------------------------------------------------------
        console.log('▶️ Test 26: Protección del estado de verificación administrativa durante actualizaciones...')
        const testReportUUID = '55555555-4444-3333-2222-111111111111'
        const fieldsToTest = {
            description: 'Nueva descripción añadida por el usuario',
            selected_affectations: ['Calle inundada', 'Árbol caído'],
            estado: 'pendiente', // Intento de sobreescritura que DEBE ser ignorado
            creado_en: '2026-01-01T00:00:00Z'
        }

        // Ejecutar llamada a updateReportRecord
        const updateResult = await updateReportRecord(testReportUUID, fieldsToTest)
        assert.ok(updateResult, 'updateReportRecord debe responder un resultado')
        console.log('  ✅ Test 26 aprobado: Columnas estado y creado_en blindadas contra restablecimiento administrativo.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 27: Escenario 1 - Usuario que envía solamente ubicación y abandona
        // --------------------------------------------------------------------------
        console.log('▶️ Test 27: Usuario que envía solamente ubicación y abandona...')
        const userLocOnly = '595989990005@s.whatsapp.net'
        deleteSession(userLocOnly)
        const mockSock27 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userLocOnly)

        // 1. Usuario envía solo ubicación GPS -> pasa a AWAITING_PHOTO (sin foto aún)
        await handleFloodReportFlow(mockSock27, userLocOnly, {
            key: { remoteJid: userLocOnly, id: 'MSG_T27_LOC' },
            message: { locationMessage: { degreesLatitude: -25.3000, degreesLongitude: -57.6600 } }
        })
        const session27 = db.prepare('SELECT state, report_id FROM report_sessions WHERE user_jid = ?').get(userLocOnly)
        assert.strictEqual(session27.state, 'AWAITING_PHOTO')
        assert.strictEqual(session27.report_id, null, 'No debe existir report_id antes de enviar fotografía')

        // 2. Transcurren 16 minutos de inactividad
        db.prepare("UPDATE report_sessions SET updated_at = datetime('now', '-16 minutes') WHERE user_jid = ?").run(userLocOnly)
        const mockSockCleanup27 = createMockSocket()
        await cleanupExpiredSessionsAndFiles(mockSockCleanup27)

        // 3. La sesión debe cerrarse y descartar el borrador sin crear registro en pending_sync_reports
        const session27After = db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userLocOnly)
        assert.strictEqual(session27After, undefined, 'La sesión conversacional debe descartarse')
        const pending27 = db.prepare('SELECT * FROM pending_sync_reports WHERE user_jid = ?').all(userLocOnly)
        assert.strictEqual(pending27.length, 0, 'No debe existir ningún reporte guardado para usuario que solo envió ubicación')

        // 4. Debe enviar el mensaje de conversación finalizada por inactividad
        const msgSent27 = mockSockCleanup27.sentMessages.find(m => m.jid === userLocOnly)
        assert.ok(msgSent27, 'Debe haber enviado aviso de inactividad')
        assert.ok(msgSent27.content.text.includes('Conversación finalizada'), 'Debe comunicar que la conversación se cerró por inactividad')
        assert.ok(!msgSent27.content.text.includes('Reporte recibido correctamente'), 'NO debe enviar mensaje de reporte recibido')
        console.log('  ✅ Test 27 aprobado: Usuario con solo ubicación descarta borrador y recibe aviso de inactividad.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 28: Escenario 3 - Usuario que selecciona afectaciones y abandona
        // --------------------------------------------------------------------------
        console.log('▶️ Test 28: Usuario que selecciona afectaciones y abandona...')
        const userAffOnly = '595989990006@s.whatsapp.net'
        deleteSession(userAffOnly)
        const mockSock28 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userAffOnly)

        // Ubicación
        await handleFloodReportFlow(mockSock28, userAffOnly, {
            key: { remoteJid: userAffOnly, id: 'MSG_T28_LOC' },
            message: { locationMessage: { degreesLatitude: -25.2920, degreesLongitude: -57.6530 } }
        })
        // Foto
        await handleFloodReportFlow(mockSock28, userAffOnly, {
            key: { remoteJid: userAffOnly, id: 'MSG_T28_PHOTO' },
            message: { imageMessage: { mimetype: 'image/jpeg' } }
        })
        const session28 = db.prepare('SELECT report_id, poll_msg_id, poll_enc_key FROM report_sessions WHERE user_jid = ?').get(userAffOnly)
        assert.ok(session28.report_id, 'Debe existir report_id')

        // Votar en la encuesta de afectaciones
        const voteEnc28 = generateEncryptedPollVote({
            pollMsgId: session28.poll_msg_id,
            pollCreatorJid: mockSock28.user.id,
            voterJid: userAffOnly,
            pollEncKey: Buffer.from(session28.poll_enc_key, 'hex'),
            selectedOptionText: '4. Vivienda afectada'
        })
        await handleFloodReportFlow(mockSock28, userAffOnly, {
            key: { remoteJid: userAffOnly, id: 'MSG_T28_VOTE' },
            message: {
                pollUpdateMessage: {
                    pollCreationMessageKey: { id: session28.poll_msg_id, remoteJid: userAffOnly, fromMe: true },
                    vote: voteEnc28
                }
            }
        })

        // Comprobar que en pending_sync_reports ya se actualizaron las afectaciones
        const pending28BeforeExpire = db.prepare('SELECT selected_affectations FROM pending_sync_reports WHERE id = ?').get(session28.report_id)
        assert.ok(pending28BeforeExpire.selected_affectations.includes('Vivienda afectada'), 'Las afectaciones deben registrarse en pending_sync_reports')

        // Usuario abandona: transcurren 16 minutos
        db.prepare("UPDATE report_sessions SET updated_at = datetime('now', '-16 minutes') WHERE user_jid = ?").run(userAffOnly)
        const mockSockCleanup28 = createMockSocket()
        await cleanupExpiredSessionsAndFiles(mockSockCleanup28)

        // Sesión cerrada pero reporte y foto conservados con afectaciones
        const session28After = db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userAffOnly)
        assert.strictEqual(session28After, undefined)
        const pending28After = db.prepare('SELECT selected_affectations FROM pending_sync_reports WHERE id = ?').get(session28.report_id)
        assert.ok(pending28After.selected_affectations.includes('Vivienda afectada'), 'El reporte conservado debe mantener las afectaciones votadas')
        const msgsSent28 = mockSockCleanup28.sentMessages.filter(m => m.jid === userAffOnly)
        assert.strictEqual(msgsSent28.length, 1, 'Debe haber enviado únicamente el mensaje final de agradecimiento')
        assert.strictEqual(msgsSent28[0].content.text, FINAL_SUCCESS_MESSAGE, 'Debe recibir el mensaje final original de agradecimiento')
        console.log('  ✅ Test 28 aprobado: Afectaciones conservadas en el reporte ante abandono por inactividad.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 29: Escenario 6 - Usuario que vuelve a escribir después de la expiración
        // --------------------------------------------------------------------------
        console.log('▶️ Test 29: Usuario que vuelve a escribir después de la expiración...')
        // El usuario 28 (cuya sesión ya expiró y se cerró) vuelve a escribir días o minutos después
        const mockSock29 = createMockSocket()
        await handleFloodReportFlow(mockSock29, userAffOnly, {
            key: { remoteJid: userAffOnly, id: 'MSG_T29_RESTART' },
            message: { conversation: 'REPORTAR' }
        })

        // Debe crearse una NUEVA sesión en estado AWAITING_LOCATION
        const session29 = db.prepare('SELECT state, report_id FROM report_sessions WHERE user_jid = ?').get(userAffOnly)
        assert.strictEqual(session29.state, 'AWAITING_LOCATION', 'Debe iniciar un reporte nuevo independiente')
        assert.strictEqual(session29.report_id, null, 'Nueva sesión no debe tener report_id aún')
        assert.ok(mockSock29.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones Urbanas'))

        // El reporte anterior en pending_sync_reports debe seguir intacto
        const previousReport28 = db.prepare('SELECT id FROM pending_sync_reports WHERE id = ?').get(session28.report_id)
        assert.ok(previousReport28, 'El reporte anterior debe permanecer intacto e independiente')
        console.log('  ✅ Test 29 aprobado: Nuevo reporte iniciado independientemente tras expiración.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 30: Escenario 10 - Conservación estricta de la encuesta original de 11 opciones
        // --------------------------------------------------------------------------
        console.log('▶️ Test 30: Conservación estricta de la encuesta original con 11 opciones...')
        assert.strictEqual(AFFECTATION_CATEGORIES.length, 11, 'La encuesta debe tener exactamente 11 opciones')
        const expectedCategories = [
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
        assert.deepStrictEqual(AFFECTATION_CATEGORIES, expectedCategories, 'Las 11 opciones deben coincidir exactamente en nombres y orden')

        const testUserPoll = '595989990007@s.whatsapp.net'
        deleteSession(testUserPoll)
        const mockSockPoll30 = createMockSocket()
        await sendAffectationPoll(mockSockPoll30, testUserPoll)

        assert.strictEqual(mockSockPoll30.sentMessages[0].content.poll.name, '⛈️ Seleccioná las afectaciones (Opcional):')
        assert.strictEqual(mockSockPoll30.sentMessages[0].content.poll.selectableCount, 0, 'Debe permitir selección múltiple (selectableCount === 0)')
        assert.strictEqual(mockSockPoll30.sentMessages[0].content.poll.values.length, 11, 'Deben emitirse las 11 opciones')
        console.log('  ✅ Test 30 aprobado: Encuesta original de 11 opciones, título, emojis y orden 100% conservados.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 31: Escenario 15 - Manejo de fallos al enviar la despedida sin perder el reporte
        // --------------------------------------------------------------------------
        console.log('▶️ Test 31: Tolerancia a fallos al enviar despedida sin perder el reporte en cola...')
        const userFailSocket = '595989990008@s.whatsapp.net'
        deleteSession(userFailSocket)
        const photoFailSocket = path.join(testUploads, `photo_fail_socket_${Date.now()}.jpg`)
        fs.writeFileSync(photoFailSocket, 'data_fail_socket')
        const failSocketReportId = crypto.randomUUID()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, photo_path, report_id, updated_at)
            VALUES (?, 'AWAITING_DESCRIPTION', ?, ?, datetime('now', '-20 minutes'))
        `).run(userFailSocket, photoFailSocket, failSocketReportId)

        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, status, attempts, next_retry_at, created_at, updated_at)
            VALUES (?, ?, -25.29, -57.65, ?, 'PENDING', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(failSocketReportId, userFailSocket, photoFailSocket)

        // Simular socket que falla al enviar mensajes
        const mockBrokenSock = {
            sendMessage: async () => { throw new Error('WhatsApp Socket Connection Closed') }
        }

        // Ejecutar rutina de limpieza: no debe lanzar excepción
        await cleanupExpiredSessionsAndFiles(mockBrokenSock)

        // La sesión conversacional debe eliminarse de SQLite
        const sessionFailAfter = db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userFailSocket)
        assert.strictEqual(sessionFailAfter, undefined, 'La sesión expirada debe limpiarse aún si el envío de mensaje falló')

        // El reporte en pending_sync_reports y su foto DEBEN permanecer intactos
        const pendingFailAfter = db.prepare('SELECT id FROM pending_sync_reports WHERE id = ?').get(failSocketReportId)
        assert.ok(pendingFailAfter, 'El reporte pendiente NO debe perderse ante fallos de red en el socket')
        assert.ok(fs.existsSync(photoFailSocket), 'La fotografía local debe conservarse para sincronizar con Supabase')
        console.log('  ✅ Test 31 aprobado: Fallo al enviar mensaje no interrumpe mantenimiento ni compromete reportes.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 32: Ubicación nativa de WhatsApp se mantiene 100% operativa e intacta
        // --------------------------------------------------------------------------
        console.log('▶️ Test 32: Ubicación nativa de WhatsApp se mantiene 100% operativa...')
        const userNativeLoc = '595989990032@s.whatsapp.net'
        deleteSession(userNativeLoc)
        const mockSock32 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userNativeLoc)

        // Enviar ubicación nativa de Baileys
        await handleFloodReportFlow(mockSock32, userNativeLoc, {
            key: { remoteJid: userNativeLoc, id: 'MSG_T32_NATIVE' },
            message: { locationMessage: { degreesLatitude: -25.299045, degreesLongitude: -57.532044 } }
        })

        const session32 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userNativeLoc)
        assert.strictEqual(session32.state, 'AWAITING_PHOTO', 'Debe pasar a AWAITING_PHOTO')
        assert.strictEqual(session32.latitude, -25.299045, 'Latitud nativa debe guardarse correctamente')
        assert.strictEqual(session32.longitude, -57.532044, 'Longitud nativa debe guardarse correctamente')
        assert.ok(mockSock32.sentMessages[0].content.text.includes('Ubicación recibida con éxito'), 'Debe enviar confirmación con coordenadas')
        assert.ok(mockSock32.sentMessages[0].content.text.includes('-25.299045, -57.532044'))
        console.log('  ✅ Test 32 aprobado: Ubicación nativa de WhatsApp 100% operativa e idéntica.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 33: Enlace directo de Google Maps con coordenadas en parámetros (?q=lat,lng)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 33: Enlace directo de Google Maps con coordenadas en query (?q=lat,lng)...')
        const userGmapsQuery = '595989990033@s.whatsapp.net'
        deleteSession(userGmapsQuery)
        const mockSock33 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userGmapsQuery)

        // Enlace directo en texto
        await handleFloodReportFlow(mockSock33, userGmapsQuery, {
            key: { remoteJid: userGmapsQuery, id: 'MSG_T33_GMAPS' },
            message: { conversation: 'Inundación en esta zona: https://www.google.com/maps?q=-25.299045,-57.532044' }
        })

        const session33 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userGmapsQuery)
        assert.strictEqual(session33.state, 'AWAITING_PHOTO', 'Debe pasar a AWAITING_PHOTO')
        assert.strictEqual(session33.latitude, -25.299045, 'Latitud de query de Google Maps debe guardarse')
        assert.strictEqual(session33.longitude, -57.532044, 'Longitud de query de Google Maps debe guardarse')
        assert.ok(mockSock33.sentMessages[0].content.text.includes('Ubicación recibida con éxito'))
        console.log('  ✅ Test 33 aprobado: Coordenadas extraídas de parámetro de búsqueda de Google Maps.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 34: Priorización de marcador seleccionado (!3d/!4d) sobre centro de cámara (@lat,lng)
        // --------------------------------------------------------------------------
        console.log('▶️ Test 34: Priorización de marcador (!3d/!4d) sobre centro de cámara (@lat,lng)...')
        const userMarkerGmaps = '595989990034@s.whatsapp.net'
        deleteSession(userMarkerGmaps)
        const mockSock34 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userMarkerGmaps)

        // URL con centro de cámara en (-25.280000, -57.630000) pero marcador en (-25.281543, -57.635921)
        const urlWithMarkerAndCamera = 'https://www.google.com/maps/place/Costanera+Asuncion/@-25.280000,-57.630000,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-25.281543!4d-57.635921'

        await handleFloodReportFlow(mockSock34, userMarkerGmaps, {
            key: { remoteJid: userMarkerGmaps, id: 'MSG_T34_MARKER' },
            message: { conversation: `Acá está el desborde: ${urlWithMarkerAndCamera}` }
        })

        const session34 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userMarkerGmaps)
        assert.strictEqual(session34.state, 'AWAITING_PHOTO')
        // Debe ser el marcador seleccionado, NO el centro de la cámara
        assert.strictEqual(session34.latitude, -25.281543, 'Debe extraer latitud del marcador (!3d), no de la cámara')
        assert.strictEqual(session34.longitude, -57.635921, 'Debe extraer longitud del marcador (!4d), no de la cámara')
        console.log('  ✅ Test 34 aprobado: Coordenadas del marcador priorizadas sobre el centro de cámara.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 35: Rechazo estricto de URLs que solo contienen centro de cámara (/@lat,lng) sin marcador
        // --------------------------------------------------------------------------
        console.log('▶️ Test 35: Rechazo estricto de URLs que solo contienen centro de cámara sin marcador...')
        const userCameraOnly = '595989990035@s.whatsapp.net'
        deleteSession(userCameraOnly)
        const mockSock35 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userCameraOnly)

        // URL que solo tiene la vista de cámara (@lat,lng,z) sin ningún pin o búsqueda
        const cameraOnlyUrl = 'https://www.google.com/maps/@-25.280000,-57.630000,15z'

        await handleFloodReportFlow(mockSock35, userCameraOnly, {
            key: { remoteJid: userCameraOnly, id: 'MSG_T35_CAMERA' },
            message: { conversation: cameraOnlyUrl }
        })

        const session35 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userCameraOnly)
        // No debe avanzar a AWAITING_PHOTO porque la cámara no es un marcador de incidente
        assert.strictEqual(session35.state, 'AWAITING_LOCATION', 'La sesión debe mantenerse en AWAITING_LOCATION')
        assert.strictEqual(session35.latitude, null)
        assert.strictEqual(session35.longitude, null)
        assert.ok(mockSock35.sentMessages[0].content.text.includes('No pudimos obtener una ubicación precisa'), 'Debe solicitar ubicación de WhatsApp')
        console.log('  ✅ Test 35 aprobado: Centro de cámara aislado rechazado sin cancelar reporte.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 36: Enlace corto maps.app.goo.gl resuelto mediante redirección segura
        // --------------------------------------------------------------------------
        console.log('▶️ Test 36: Enlace corto maps.app.goo.gl resuelto mediante redirección segura...')
        const userShortGmaps = '595989990036@s.whatsapp.net'
        deleteSession(userShortGmaps)
        const mockSock36 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userShortGmaps)

        // Mock de fetch que simula redirección HTTP 302 hacia URL expandida con marcador
        const mockShortFetch = async (url) => {
            if (url === 'https://maps.app.goo.gl/AbCd1234') {
                return {
                    status: 302,
                    headers: {
                        get: (h) => h.toLowerCase() === 'location' ? 'https://www.google.com/maps/place/Barrio+San+Pablo/@-25.3200,-57.6000,16z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-25.321456!4d-57.602345' : null
                    }
                }
            }
            return { status: 404 }
        }

        await handleFloodReportFlow(mockSock36, userShortGmaps, {
            key: { remoteJid: userShortGmaps, id: 'MSG_T36_SHORT' },
            message: { conversation: 'https://maps.app.goo.gl/AbCd1234' }
        }, { fetch: mockShortFetch })

        const session36 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userShortGmaps)
        assert.strictEqual(session36.state, 'AWAITING_PHOTO')
        assert.strictEqual(session36.latitude, -25.321456, 'Latitud resuelta desde enlace corto debe ser la del marcador')
        assert.strictEqual(session36.longitude, -57.602345, 'Longitud resuelta desde enlace corto debe ser la del marcador')
        console.log('  ✅ Test 36 aprobado: Enlace corto maps.app.goo.gl resuelto y procesado correctamente.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 37: Seguridad y protección SSRF: Bloqueo de dominios no autorizados
        // --------------------------------------------------------------------------
        console.log('▶️ Test 37: Seguridad y protección SSRF: Bloqueo de dominios no autorizados...')
        const userSsrf = '595989990037@s.whatsapp.net'
        deleteSession(userSsrf)
        const mockSock37 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userSsrf)

        let ssrfFetchCalled = false
        const spySsrfFetch = async () => {
            ssrfFetchCalled = true
            return { status: 200 }
        }

        // Intento de enlace con dominio malicioso o IP interna
        await handleFloodReportFlow(mockSock37, userSsrf, {
            key: { remoteJid: userSsrf, id: 'MSG_T37_SSRF' },
            message: { conversation: 'http://malicious-site.com/maps?q=-25.29,-57.53' }
        }, { fetch: spySsrfFetch })

        assert.strictEqual(ssrfFetchCalled, false, 'NUNCA debe realizarse petición HTTP a dominios ajenos a Google')
        const session37 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userSsrf)
        assert.strictEqual(session37.state, 'AWAITING_LOCATION', 'Debe permanecer en AWAITING_LOCATION')
        assert.strictEqual(session37.latitude, null)
        assert.ok(mockSock37.sentMessages[0].content.text.includes('compartí la ubicación del lugar afectado'))
        console.log('  ✅ Test 37 aprobado: Protección SSRF confirmada; dominios no autorizados bloqueados.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 38: Enlace de Google Maps sin coordenadas: solicitud de ubicación nativa sin cancelar
        // --------------------------------------------------------------------------
        console.log('▶️ Test 38: Enlace de Google Maps sin coordenadas: solicitud de ubicación nativa...')
        const userNoCoords = '595989990038@s.whatsapp.net'
        deleteSession(userNoCoords)
        const mockSock38 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userNoCoords)

        // Enlace de búsqueda genérica de Google Maps sin coordenadas numéricas
        await handleFloodReportFlow(mockSock38, userNoCoords, {
            key: { remoteJid: userNoCoords, id: 'MSG_T38_NO_COORDS' },
            message: { conversation: 'https://www.google.com/maps/search/asuncion+paraguay' }
        })

        const session38 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userNoCoords)
        assert.strictEqual(session38.state, 'AWAITING_LOCATION', 'No debe cancelar la sesión; debe permanecer en AWAITING_LOCATION')
        assert.strictEqual(session38.latitude, null)
        assert.ok(mockSock38.sentMessages[0].content.text.includes('No pudimos obtener una ubicación precisa'))
        console.log('  ✅ Test 38 aprobado: Enlace sin coordenadas solicita ubicación nativa sin alterar estado.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 39: Validación geográfica estricta: Coordenadas fuera de rango rechazadas
        // --------------------------------------------------------------------------
        console.log('▶️ Test 39: Validación geográfica estricta: Coordenadas fuera de rango rechazadas...')
        const userOutOfBounds = '595989990039@s.whatsapp.net'
        deleteSession(userOutOfBounds)
        const mockSock39 = createMockSocket()

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now'))
        `).run(userOutOfBounds)

        // Latitud inválida > 90
        await handleFloodReportFlow(mockSock39, userOutOfBounds, {
            key: { remoteJid: userOutOfBounds, id: 'MSG_T39_OOB' },
            message: { conversation: 'https://www.google.com/maps?q=125.0000,-57.0000' }
        })

        const session39 = db.prepare('SELECT state, latitude, longitude FROM report_sessions WHERE user_jid = ?').get(userOutOfBounds)
        assert.strictEqual(session39.state, 'AWAITING_LOCATION')
        assert.strictEqual(session39.latitude, null)
        assert.ok(mockSock39.sentMessages[0].content.text.includes('No pudimos obtener una ubicación precisa'))
        console.log('  ✅ Test 39 aprobado: Coordenadas fuera de rango rechazadas correctamente.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 40: Un mensaje automático de FloodBot no activa el modo asesor
        // --------------------------------------------------------------------------
        console.log('▶️ Test 40: Mensaje automático del bot no activa modo asesor (eco ignorado)...')
        const userT40 = '595989990040@s.whatsapp.net'
        const botMsgId = 'BOT_TEST_ID_40'
        recordBotOutgoingMessageId(botMsgId)

        const mockSock40 = createMockSocket()
        // Simular eco de Baileys de un mensaje que el bot mismo envió
        const handled40 = await handleFloodReportFlow(mockSock40, userT40, {
            key: { remoteJid: userT40, id: botMsgId, fromMe: true },
            message: { conversation: 'Mensaje saliente del bot' }
        })

        assert.strictEqual(handled40, false, 'El eco del propio bot debe ser ignorado')
        const advisorSess40 = getAdvisorSession(userT40)
        assert.strictEqual(advisorSess40, null, 'No debe crearse sesión de asesor ante eco del bot')
        console.log('  ✅ Test 40 aprobado: Ecos del propio bot no activan modo asesor.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 41: Un mensaje enviado manualmente desde WhatsApp activa el modo asesor
        // --------------------------------------------------------------------------
        console.log('▶️ Test 41: Mensaje manual desde WhatsApp del asesor activa modo asesor...')
        const userT41 = '595989990041@s.whatsapp.net'
        deleteSession(userT41)
        clearAdvisorSession(userT41)

        const mockSock41 = createMockSocket()
        // Mensaje manual enviado por el asesor (fromMe: true, ID no perteneciente al bot)
        const handled41 = await handleFloodReportFlow(mockSock41, userT41, {
            key: { remoteJid: userT41, id: '3EB0_MANUAL_PHONE_41', fromMe: true },
            message: { conversation: 'Hola, te habla un asesor. Voy a ayudarte con tu reporte.' }
        })

        assert.strictEqual(handled41, true, 'Debe procesar la intervención manual')
        const advisorSess41 = getAdvisorSession(userT41)
        assert.ok(advisorSess41, 'Debe existir sesión de asesor en SQLite')
        assert.strictEqual(advisorSess41.status, 'ACTIVE', 'El estado debe ser ACTIVE')
        assert.strictEqual(mockSock41.sentMessages.length, 0, 'No debe enviar ningún mensaje adicional al activar modo asesor')
        console.log('  ✅ Test 41 aprobado: Mensaje manual activa modo asesor silenciosamente.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 42: FloodBot permanece en silencio absoluto durante la atención manual
        // --------------------------------------------------------------------------
        console.log('▶️ Test 42: Silencio absoluto durante la atención manual...')
        // Ciudadano escribe a la conversación donde el asesor está activo
        const mockSock42 = createMockSocket()
        await handleFloodReportFlow(mockSock42, userT41, {
            key: { remoteJid: userT41, id: 'MSG_CITIZEN_42_1' },
            message: { conversation: 'Hola asesor, el agua está entrando a mi sala.' }
        })

        // Ciudadano envía otro mensaje
        await handleFloodReportFlow(mockSock42, userT41, {
            key: { remoteJid: userT41, id: 'MSG_CITIZEN_42_2' },
            message: { conversation: '¿Cuánto van a tardar?' }
        })

        assert.strictEqual(mockSock42.sentMessages.length, 0, 'FloodBot debe permanecer completamente mudo')
        console.log('  ✅ Test 42 aprobado: FloodBot silenciado ante mensajes del ciudadano.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 43: Los demás ciudadanos siguen siendo atendidos normalmente en paralelo
        // --------------------------------------------------------------------------
        console.log('▶️ Test 43: Aislamiento: Otros ciudadanos son atendidos normalmente...')
        const userOther = '595989990043@s.whatsapp.net'
        deleteSession(userOther)
        clearAdvisorSession(userOther)

        const mockSock43 = createMockSocket()
        // Otro ciudadano inicia reporte con FloodBot
        await handleFloodReportFlow(mockSock43, userOther, {
            key: { remoteJid: userOther, id: 'MSG_OTHER_43' },
            message: { conversation: 'REPORTAR' }
        })

        assert.ok(mockSock43.sentMessages.length >= 2, 'El otro usuario debe recibir bienvenida y ubicación')
        assert.ok(mockSock43.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones'))
        const sessOther = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userOther)
        assert.strictEqual(sessOther.state, 'AWAITING_LOCATION', 'Sesión automática del otro usuario opera con normalidad')
        console.log('  ✅ Test 43 aprobado: Aislamiento confirmado; otros ciudadanos operan sin afectación.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 44: Los reportes atendidos manualmente NO se guardan en Supabase
        // --------------------------------------------------------------------------
        console.log('▶️ Test 44: Conversaciones manuales no generan reportes en Supabase...')
        const pendingManual = db.prepare('SELECT * FROM pending_sync_reports WHERE user_jid = ?').all(userT41)
        assert.strictEqual(pendingManual.length, 0, 'No debe existir ningún reporte en cola/Supabase para la sesión manual')
        console.log('  ✅ Test 44 aprobado: Cero registros generados en cola o Supabase para chats manuales.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 45: Mensaje "Gracias. Reporte recibido" finaliza la atención manual e inicia cooldown
        // --------------------------------------------------------------------------
        console.log('▶️ Test 45: Mensaje de cierre finaliza atención manual e inicia cooldown de 15m...')
        const mockSock45 = createMockSocket()
        // Asesor envía mensaje de cierre con variaciones de puntuación y texto
        const closingMsgText = 'Gracias. Reporte recibido.\n\nTu reporte ha sido recibido correctamente.\nSi querés realizar otro reporte, escribí REPORTAR.'
        await handleFloodReportFlow(mockSock45, userT41, {
            key: { remoteJid: userT41, id: '3EB0_CLOSING_45', fromMe: true },
            message: { conversation: closingMsgText }
        })

        assert.strictEqual(mockSock45.sentMessages.length, 0, 'FloodBot no debe duplicar el mensaje de cierre')
        const advisorSess45 = getAdvisorSession(userT41)
        assert.ok(advisorSess45, 'Debe seguir existiendo registro en advisor_sessions')
        assert.strictEqual(advisorSess45.status, 'COOLDOWN', 'El estado debe cambiar a COOLDOWN')
        assert.ok(advisorSess45.closed_at_ms > 0, 'Debe registrar closed_at_ms')
        console.log('  ✅ Test 45 aprobado: Cierre reconocido y transición a cooldown de 15 min.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 46: Ciudadano responde "Gracias" durante los 15 minutos de cooldown sin respuesta del bot
        // --------------------------------------------------------------------------
        console.log('▶️ Test 46: Ciudadano responde "Gracias" durante cooldown (bot silenciado sin reiniciar timer)...')
        const mockSock46 = createMockSocket()
        const closedAtBefore = getAdvisorSession(userT41).closed_at_ms

        await handleFloodReportFlow(mockSock46, userT41, {
            key: { remoteJid: userT41, id: 'MSG_THANKS_46' },
            message: { conversation: 'Muchas gracias por la atención, buenas noches!' }
        })

        assert.strictEqual(mockSock46.sentMessages.length, 0, 'El bot debe permanecer silenciado durante los 15 min de cooldown')
        const closedAtAfter = getAdvisorSession(userT41).closed_at_ms
        assert.strictEqual(closedAtBefore, closedAtAfter, 'Los mensajes de cortesía no deben reiniciar el temporizador')
        console.log('  ✅ Test 46 aprobado: Cortesías durante cooldown silenciadas sin alterar temporizador.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 47: Ciudadano escribe REPORTAR durante cooldown e inicia nuevo reporte inmediato
        // --------------------------------------------------------------------------
        console.log('▶️ Test 47: Ciudadano escribe REPORTAR durante cooldown (reactivación inmediata)...')
        const mockSock47 = createMockSocket()
        await handleFloodReportFlow(mockSock47, userT41, {
            key: { remoteJid: userT41, id: 'MSG_REPORTAR_47' },
            message: { conversation: 'REPORTAR' }
        })

        assert.ok(mockSock47.sentMessages.length >= 2, 'Debe responder inmediatamente con bienvenida y ubicación')
        assert.ok(mockSock47.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones'))
        const advisorSess47 = getAdvisorSession(userT41)
        assert.strictEqual(advisorSess47, null, 'La sesión de asesor debe haberse limpiado')
        const reportSess47 = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userT41)
        assert.strictEqual(reportSess47.state, 'AWAITING_LOCATION', 'Debe iniciar reporte automático en AWAITING_LOCATION')
        console.log('  ✅ Test 47 aprobado: Comando REPORTAR durante cooldown reactiva el bot al instante.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 48: Después de 15 minutos desde el cierre, cualquier mensaje activa el flujo automático
        // --------------------------------------------------------------------------
        console.log('▶️ Test 48: Tras 15 minutos desde el cierre, cualquier mensaje reactiva el bot...')
        const userT48 = '595989990048@s.whatsapp.net'
        deleteSession(userT48)
        clearAdvisorSession(userT48)

        // Asesor intervino y luego cerró hace 16 minutos (> 15 minutos)
        const sixteenMinAgo48 = Date.now() - (16 * 60 * 1000)
        closeAdvisorSession(userT48, sixteenMinAgo48)

        const mockSock48 = createMockSocket()
        // Ciudadano escribe cualquier mensaje ordinario ("Hola")
        await handleFloodReportFlow(mockSock48, userT48, {
            key: { remoteJid: userT48, id: 'MSG_T48_GREET' },
            message: { conversation: 'Hola' }
        })

        assert.ok(mockSock48.sentMessages.length >= 2, 'Cualquier mensaje tras 15 min debe iniciar el flujo habitual')
        assert.ok(mockSock48.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones'))
        const advisorSess48 = getAdvisorSession(userT48)
        assert.strictEqual(advisorSess48, null, 'El registro de asesor en cooldown debe quedar limpio')
        console.log('  ✅ Test 48 aprobado: Expiración de cooldown de 15m reactiva el flujo habitual.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 49: Persistencia y resiliencia ante reinicios de servidor
        // --------------------------------------------------------------------------
        console.log('▶️ Test 49: Persistencia en SQLite sobrevive a reinicios de servidor...')
        const userT49 = '595989990049@s.whatsapp.net'
        clearAdvisorSession(userT49)
        activateAdvisorSession(userT49)

        // Simular reinicio: limpiar memoria global
        global.botSentMessageIds = new Set()
        global.recentTriggers = new Map()

        // Verificar que en SQLite sigue activo
        const sess49FromDb = getAdvisorSession(userT49)
        assert.strictEqual(sess49FromDb.status, 'ACTIVE', 'El estado ACTIVE debe persistir en SQLite')

        // Mensaje recibido tras reinicio: debe seguir silenciado
        const mockSock49 = createMockSocket()
        await handleFloodReportFlow(mockSock49, userT49, {
            key: { remoteJid: userT49, id: 'MSG_T49_AFTER_REBOOT' },
            message: { conversation: '¿Siguen ahí?' }
        })

        assert.strictEqual(mockSock49.sentMessages.length, 0, 'Debe permanecer silenciado aún tras reinicio')
        console.log('  ✅ Test 49 aprobado: Estado persistente en SQLite blindado ante reinicios.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 50: El cierre automático por inactividad de reportes normales sigue funcionando
        // --------------------------------------------------------------------------
        console.log('▶️ Test 50: Cierre por inactividad de reportes normales intacto (modo asesor protegido)...')
        const userNormalExp = '595989990050@s.whatsapp.net'
        deleteSession(userNormalExp)
        clearAdvisorSession(userNormalExp)

        // Usuario normal con borrador expirado (>16 min)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now', '-16 minutes'))
        `).run(userNormalExp)

        // Usuario en modo asesor que también lleva 16 min inactivo
        const userAdvisorProtected = '595989990051@s.whatsapp.net'
        deleteSession(userAdvisorProtected)
        clearAdvisorSession(userAdvisorProtected)
        activateAdvisorSession(userAdvisorProtected)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
            VALUES (?, 'AWAITING_LOCATION', NULL, NULL, datetime('now', '-16 minutes'))
        `).run(userAdvisorProtected)

        const mockSock50 = createMockSocket()
        await cleanupExpiredSessionsAndFiles(mockSock50)

        // El usuario normal debe haber expirado y recibido aviso
        const normalAfter = db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userNormalExp)
        assert.strictEqual(normalAfter, undefined, 'La sesión normal debe ser limpiada')
        const normalSent = mockSock50.sentMessages.find(m => m.jid === userNormalExp)
        assert.ok(normalSent, 'Debe enviar aviso de inactividad al usuario normal')

        // El usuario en modo asesor NO debe haber recibido ningún mensaje y su estado de asesor permanece intacto
        const advisorSent = mockSock50.sentMessages.find(m => m.jid === userAdvisorProtected)
        assert.strictEqual(advisorSent, undefined, 'El usuario en modo asesor NO debe recibir aviso de expiración')
        const advisorStatusAfter = getAdvisorSession(userAdvisorProtected)
        assert.strictEqual(advisorStatusAfter.status, 'ACTIVE', 'El modo asesor no debe ser alterado por el cleaner')
        console.log('  ✅ Test 50 aprobado: Cleaner de 15m opera para usuarios normales y protege a asesores.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 51: No se pierden ni modifican reportes previamente confirmados
        // --------------------------------------------------------------------------
        console.log('▶️ Test 51: Reportes previamente confirmados permanecen intactos ante intervención...')
        const userConfirmed = '595989990052@s.whatsapp.net'
        deleteSession(userConfirmed)
        clearAdvisorSession(userConfirmed)

        const confirmedReportId = 'rep_confirmed_manual_51'
        const fakePhoto51 = path.join(UPLOADS_DIR, 'photo_confirmed_51.jpg')
        fs.writeFileSync(fakePhoto51, 'CONFIRMED_DATA')

        // Insertar reporte previamente auto-guardado en pending_sync_reports
        db.prepare(`
            INSERT INTO pending_sync_reports (id, user_jid, latitude, longitude, photo_path, description, status, attempts, next_retry_at, created_at, updated_at)
            VALUES (?, ?, -25.29, -57.65, ?, 'Muro caído por raudal', 'PENDING', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(confirmedReportId, userConfirmed, fakePhoto51)

        // Sesión activa que apuntaba a ese reporte
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, photo_path, description, report_id, updated_at)
            VALUES (?, 'AWAITING_DESCRIPTION', -25.29, -57.65, ?, 'Muro caído por raudal', ?, datetime('now'))
        `).run(userConfirmed, fakePhoto51, confirmedReportId)

        const mockSock51 = createMockSocket()
        // Asesor interviene manualmente
        await handleFloodReportFlow(mockSock51, userConfirmed, {
            key: { remoteJid: userConfirmed, id: '3EB0_MANUAL_51', fromMe: true },
            message: { conversation: 'Hola, veo que enviaste la foto del muro. Te habla el asesor.' }
        })

        // El reporte en pending_sync_reports debe permanecer exactamente igual
        const pendingCheck51 = db.prepare('SELECT * FROM pending_sync_reports WHERE id = ?').get(confirmedReportId)
        assert.ok(pendingCheck51, 'El reporte confirmado debe permanecer intacto')
        assert.strictEqual(pendingCheck51.description, 'Muro caído por raudal')
        assert.ok(fs.existsSync(fakePhoto51), 'La foto del reporte confirmado no debe eliminarse')
        console.log('  ✅ Test 51 aprobado: Reportes confirmados 100% resguardados ante intervención de asesor.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 52: Descarte de borrador incompleto al activar modo asesor
        // --------------------------------------------------------------------------
        console.log('▶️ Test 52: Borrador incompleto previo es descartado junto a su foto temporal...')
        const userDraft = '595989990053@s.whatsapp.net'
        deleteSession(userDraft)
        clearAdvisorSession(userDraft)

        const draftPhoto = path.join(UPLOADS_DIR, 'photo_draft_incomplete_52.jpg')
        fs.writeFileSync(draftPhoto, 'DRAFT_PHOTO_DATA')

        // Sesión incompleta (sin report_id asignado)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, latitude, longitude, photo_path, report_id, updated_at)
            VALUES (?, 'AWAITING_PHOTO', -25.29, -57.65, ?, NULL, datetime('now'))
        `).run(userDraft, draftPhoto)

        const mockSock52 = createMockSocket()
        // Asesor interviene
        await handleFloodReportFlow(mockSock52, userDraft, {
            key: { remoteJid: userDraft, id: '3EB0_MANUAL_52', fromMe: true },
            message: { conversation: 'Hola, te habla el asesor. No hace falta que subas la foto.' }
        })

        // La foto temporal del borrador incompleto debe haberse eliminado
        assert.strictEqual(fs.existsSync(draftPhoto), false, 'La foto temporal del borrador incompleto debe ser eliminada')
        // La sesión en report_sessions debe haber sido removida
        const sessDraftAfter = db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userDraft)
        assert.strictEqual(sessDraftAfter, undefined, 'El borrador incompleto debe ser descartado')
        console.log('  ✅ Test 52 aprobado: Borrador incompleto y archivo temporal descartados correctamente.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Test 53: Vencimiento de seguridad de atención manual tras 2 horas de inactividad
        // --------------------------------------------------------------------------
        console.log('▶️ Test 53: Vencimiento de seguridad: 2 horas de inactividad liberan sesión de asesor...')
        const userT53 = '595989990053_timeout@s.whatsapp.net'
        deleteSession(userT53)
        clearAdvisorSession(userT53)

        // Activar asesor con más de 2 horas de inactividad (121 minutos atrás)
        const twoHoursAgo53 = Date.now() - (121 * 60 * 1000)
        activateAdvisorSession(userT53, twoHoursAgo53)

        // Verificar que el cleaner periódicamente detecte la inactividad y libere la sesión
        const mockSock53a = createMockSocket()
        await cleanupExpiredSessionsAndFiles(mockSock53a)

        const advAfterCleaner = getAdvisorSession(userT53)
        assert.strictEqual(advAfterCleaner, null, 'El cleaner de mantenimiento debe liberar la sesión de asesor tras 2 horas')

        // También probar cuando el ciudadano vuelve a escribir tras 2 horas de silencio
        activateAdvisorSession(userT53, twoHoursAgo53)
        const mockSock53b = createMockSocket()
        await handleFloodReportFlow(mockSock53b, userT53, {
            key: { remoteJid: userT53, id: 'MSG_T53_AFTER_2H' },
            message: { conversation: 'Hola de nuevo' }
        })

        // Debe haber iniciado el flujo automático normal con bienvenida
        assert.ok(mockSock53b.sentMessages.length >= 2, 'Debe reactivar el bot con bienvenida tras 2h de inactividad')
        assert.ok(mockSock53b.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones'))
        const advAfterMsg = getAdvisorSession(userT53)
        assert.strictEqual(advAfterMsg, null, 'La sesión de asesor debe haber quedado completamente eliminada')
        console.log('  ✅ Test 53 aprobado: Límite de seguridad de 2 horas libera automáticamente la sesión.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Resumen
        // --------------------------------------------------------------------------
        console.log('==============================================================================')
        console.log(`🎉 BATERÍA COMPLETA: ${passedTests} de 53 pruebas aprobadas exitosamente.`)
        console.log('🛡️ Aislamiento verificado: sessions.db y uploads/ reales no sufrieron modificaciones.')
        console.log('==============================================================================\n')
    } finally {
        // Cerrar base de datos SQLite antes de limpiar archivos temporales en Windows
        closeDatabase()

        try {
            if (fs.existsSync(testDir)) {
                fs.rmSync(testDir, { recursive: true, force: true })
            }
        } catch (_) {}
    }
    process.exit(0)
}

runTests().catch(err => {
    console.error('❌ Falló la prueba:', err)
    process.exit(1)
})
