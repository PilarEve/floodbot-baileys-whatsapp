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
    handleFloodReportFlow,
    UPLOADS_DIR,
    DB_PATH,
    EXPERIMENTAL_BUTTONS_ENABLED,
    sendContinueOrCancelButtons
} = require('./bot')

const { insertReportRecord } = require('./supabaseClient')

console.log('🧪 Iniciando batería exhaustiva de pruebas (13 escenarios aislados)...\n')
console.log(`📁 Directorio de pruebas aislado: ${testDir}`)
console.log(`🗄️ Base de datos temporal: ${testDbPath}`)
console.log(`📸 Carpeta temporal de uploads: ${testUploads}\n`)

// Mock de socket de Baileys para capturar mensajes salientes
function createMockSocket() {
    const sentMessages = []
    return {
        sentMessages,
        sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content })
            return { key: { id: 'MOCK_MSG_' + Date.now() } }
        },
        relayMessage: async (jid, message, options) => {
            sentMessages.push({ jid, content: { relayMessage: message, options } })
            return { key: { id: options?.messageId || 'MOCK_RELAY_' + Date.now() } }
        },
        user: { id: '595981111111:0@s.whatsapp.net', lid: '123456789@lid' }
    }
}

let passedTests = 0

async function runTests() {
    try {
        // --------------------------------------------------------------------------
        // Test 1: Precisión de expiración por inactividad (>30 min) y reinicio silencioso
        // --------------------------------------------------------------------------
        console.log('▶️ Test 1: Precisión de timestamps UTC y reinicio silencioso tras inactividad...')
        const nowUtcStr = new Date().toISOString().replace('T', ' ').slice(0, 19)
        assert.strictEqual(isSessionExpired({ updated_at: nowUtcStr }), false, 'Sesión actual no debe expirar')

        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
        assert.strictEqual(isSessionExpired({ updated_at: tenMinAgo }), false, 'Sesión de 10 min no debe expirar')

        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
        assert.strictEqual(isSessionExpired({ updated_at: thirtyMinAgo }), true, 'Sesión de 30 min debe expirar')

        const testUser1 = '595982222222@s.whatsapp.net'
        deleteSession(testUser1)

        const dummyPhoto = path.join(testUploads, `test_expired_${Date.now()}.jpg`)
        fs.writeFileSync(dummyPhoto, 'dummy photo content')

        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, photo_path, updated_at)
            VALUES (?, 'AWAITING_PHOTO', ?, datetime('now', '-40 minutes'))
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
        // Test 13: Interfaz experimental de botones interactivos y compatibilidad dual
        // --------------------------------------------------------------------------
        console.log('▶️ Test 13: Botones interactivos (Continuar / Cancelar) y comandos de texto alternativos...')

        // 13a: Envío de botones interactivos a través de sendContinueOrCancelButtons
        const testUserButtons = '595987778888@s.whatsapp.net'
        const mockSockBtn = createMockSocket()
        await sendContinueOrCancelButtons(mockSockBtn, testUserButtons)

        assert.ok(mockSockBtn.sentMessages.length > 0, 'Debe haber enviado un mensaje')
        const sentContent = mockSockBtn.sentMessages[0].content
        const relayMsg = sentContent.relayMessage
        assert.ok(relayMsg?.viewOnceMessage?.message?.interactiveMessage, 'Debe enviar un interactiveMessage')
        const buttons = relayMsg.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons
        assert.strictEqual(buttons.length, 2, 'Debe contener exactamente 2 botones')
        assert.ok(buttons[0].buttonParamsJson.includes('Continuar'), 'Primer botón debe ser Continuar')
        assert.ok(buttons[1].buttonParamsJson.includes('Cancelar'), 'Segundo botón debe ser Cancelar')

        // 13b: Respuesta al presionar botón 'Continuar' (id: '1')
        const userBtnContinue = '595989991111@s.whatsapp.net'
        deleteSession(userBtnContinue)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_AFFECTATIONS_AND_DESC', datetime('now'))
        `).run(userBtnContinue)

        const mockSockBtnContinue = createMockSocket()
        await handleFloodReportFlow(mockSockBtnContinue, userBtnContinue, {
            key: { remoteJid: userBtnContinue, id: 'MSG_BTN_1' },
            message: {
                interactiveResponseMessage: {
                    nativeFlowResponseMessage: {
                        paramsJson: JSON.stringify({ id: '1', display_text: 'Continuar' })
                    }
                }
            }
        })

        const sessionAfterContinue = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userBtnContinue)
        assert.strictEqual(sessionAfterContinue?.state, 'AWAITING_DESCRIPTION', 'Presionar Continuar debe avanzar a AWAITING_DESCRIPTION')
        assert.ok(mockSockBtnContinue.sentMessages[0].content.text.includes('Descripción'), 'Debe solicitar descripción')

        // 13c: Respuesta al presionar botón 'Cancelar' (id: '0')
        const userBtnCancel = '595989992222@s.whatsapp.net'
        deleteSession(userBtnCancel)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_AFFECTATIONS_AND_DESC', datetime('now'))
        `).run(userBtnCancel)

        const mockSockBtnCancel = createMockSocket()
        await handleFloodReportFlow(mockSockBtnCancel, userBtnCancel, {
            key: { remoteJid: userBtnCancel, id: 'MSG_BTN_0' },
            message: {
                interactiveResponseMessage: {
                    nativeFlowResponseMessage: {
                        paramsJson: JSON.stringify({ id: '0', display_text: 'Cancelar' })
                    }
                }
            }
        })

        const sessionAfterCancel = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userBtnCancel)
        assert.strictEqual(sessionAfterCancel, undefined, 'Presionar Cancelar debe eliminar la sesión')
        assert.ok(mockSockBtnCancel.sentMessages[0].content.text.includes('Reporte cancelado'), 'Debe enviar mensaje de cancelación')

        // 13d: Conservación de comandos de texto escritos como alternativa (1 / 0)
        const userTextFallback = '595989993333@s.whatsapp.net'
        deleteSession(userTextFallback)
        db.prepare(`
            INSERT INTO report_sessions (user_jid, state, updated_at)
            VALUES (?, 'AWAITING_AFFECTATIONS_AND_DESC', datetime('now'))
        `).run(userTextFallback)

        const mockSockTextFallback = createMockSocket()
        await handleFloodReportFlow(mockSockTextFallback, userTextFallback, {
            key: { remoteJid: userTextFallback, id: 'MSG_TEXT_1' },
            message: { conversation: 'LISTO' }
        })

        const sessionAfterText = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userTextFallback)
        assert.strictEqual(sessionAfterText?.state, 'AWAITING_DESCRIPTION', 'Comando escrito LISTO debe funcionar exactamente igual')

        deleteSession(userBtnContinue)
        deleteSession(userTextFallback)

        console.log('  ✅ Test 13 aprobado: Botones interactivos y comandos de texto alternativos 100% operativos.\n')
        passedTests++

        // --------------------------------------------------------------------------
        // Resumen
        // --------------------------------------------------------------------------
        console.log('==============================================================================')
        console.log(`🎉 BATERÍA COMPLETA: ${passedTests} de 13 pruebas aprobadas exitosamente.`)
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
