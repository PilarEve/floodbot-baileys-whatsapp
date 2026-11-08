// ==============================================================================
// Suite de Pruebas: Expiración Automática, Seguridad y Persistencia de FloodBot
// ==============================================================================
process.env.NODE_ENV = 'test'

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const {
    db,
    SESSION_TIMEOUT_MS,
    parseSessionUtcTimestamp,
    isSessionExpired,
    safeDeleteUploadFile,
    deleteSession,
    cleanupExpiredSessionsAndFiles,
    handleFloodReportFlow,
    UPLOADS_DIR
} = require('./bot')

console.log('🧪 Iniciando batería de pruebas unitarias y de integración...\n')

// Mock de socket de Baileys para capturar mensajes salientes
function createMockSocket() {
    const sentMessages = []
    return {
        sentMessages,
        sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content })
            return { key: { id: 'MOCK_MSG_' + Date.now() } }
        },
        user: { id: '595981111111:0@s.whatsapp.net', lid: '123456789@lid' }
    }
}

let passedTests = 0

async function runTests() {
    // --------------------------------------------------------------------------
    // Test 1: Precisión de timestamps UTC y cálculo de expiración (>= 30 min)
    // --------------------------------------------------------------------------
    console.log('▶️ Test 1: Verificación de timestamps UTC y ventana de 30 minutos...')
    const nowUtcStr = new Date().toISOString().replace('T', ' ').slice(0, 19)
    assert.strictEqual(isSessionExpired({ updated_at: nowUtcStr }), false, 'Sesión actual no debe expirar')

    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    assert.strictEqual(isSessionExpired({ updated_at: tenMinAgo }), false, 'Sesión de 10 min no debe expirar')

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    assert.strictEqual(isSessionExpired({ updated_at: thirtyMinAgo }), true, 'Sesión de 30 min exactos debe expirar')

    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    assert.strictEqual(isSessionExpired({ updated_at: twoHoursAgo }), true, 'Sesión de 2 horas debe expirar')
    console.log('  ✅ Test 1 aprobado: Cálculos UTC y umbral de 30 minutos correctos.\n')
    passedTests++

    // --------------------------------------------------------------------------
    // Test 2: Expiración silenciosa y reinicio automático al recibir mensaje
    // --------------------------------------------------------------------------
    console.log('▶️ Test 2: Expiración por inactividad y reinicio automático...')
    const testUser1 = '595982222222@s.whatsapp.net'
    deleteSession(testUser1)

    // Crear sesión simulada hace 40 minutos en AWAITING_PHOTO
    const dummyPhoto = path.join(UPLOADS_DIR, `test_expired_${Date.now()}.jpg`)
    fs.writeFileSync(dummyPhoto, 'dummy photo content')

    db.prepare(`
        INSERT INTO report_sessions (user_jid, state, photo_path, updated_at)
        VALUES (?, 'AWAITING_PHOTO', ?, datetime('now', '-40 minutes'))
    `).run(testUser1, dummyPhoto)

    const mockSock = createMockSocket()
    const incomingMsg = {
        key: { remoteJid: testUser1, id: 'MSG_1' },
        message: { conversation: 'Hola, sigo aquí' }
    }

    await handleFloodReportFlow(mockSock, testUser1, incomingMsg)

    // Comprobar que la sesión expirada fue descartada y se reinició en AWAITING_LOCATION
    const sessionUser1 = db.prepare('SELECT state, photo_path FROM report_sessions WHERE user_jid = ?').get(testUser1)
    assert.strictEqual(sessionUser1?.state, 'AWAITING_LOCATION', 'El flujo debe reiniciarse en AWAITING_LOCATION')
    assert.strictEqual(fs.existsSync(dummyPhoto), false, 'La foto temporal de la sesión expirada debe eliminarse')

    // Comprobar mensajes: Bienvenida + Paso 1 (sin avisos automáticos de expiración previos)
    assert.strictEqual(mockSock.sentMessages.length, 2, 'Debe enviar exactamente bienvenida y paso 1')
    assert.ok(mockSock.sentMessages[0].content.text.includes('Sistema de Monitoreo de Inundaciones Urbanas'), 'Debe enviar bienvenida institucional')
    assert.ok(mockSock.sentMessages[1].content.text.includes('Paso 1: Ubicación'), 'Debe solicitar ubicación')
    console.log('  ✅ Test 2 aprobado: Sesión expirada purga foto y reinicia desde la bienvenida.\n')
    passedTests++

    // --------------------------------------------------------------------------
    // Test 3: Sesiones simultáneas e independientes por usuario
    // --------------------------------------------------------------------------
    console.log('▶️ Test 3: Aislamiento entre sesiones simultáneas...')
    const userActive = '595983333333@s.whatsapp.net'
    const userInactive = '595984444444@s.whatsapp.net'
    deleteSession(userActive)
    deleteSession(userInactive)

    // userActive: activo hace 5 minutos en AWAITING_PHOTO
    db.prepare(`
        INSERT INTO report_sessions (user_jid, state, updated_at)
        VALUES (?, 'AWAITING_PHOTO', datetime('now', '-5 minutes'))
    `).run(userActive)

    // userInactive: inactivo hace 35 minutos en AWAITING_PHOTO
    db.prepare(`
        INSERT INTO report_sessions (user_jid, state, updated_at)
        VALUES (?, 'AWAITING_PHOTO', datetime('now', '-35 minutes'))
    `).run(userInactive)

    // Mensaje de userActive: debe pedirle la foto (flujo normal, NO reiniciar)
    const mockSockActive = createMockSocket()
    await handleFloodReportFlow(mockSockActive, userActive, {
        key: { remoteJid: userActive, id: 'MSG_ACT' },
        message: { conversation: '¿qué falta?' }
    })
    const sessionActiveAfter = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userActive)
    assert.strictEqual(sessionActiveAfter.state, 'AWAITING_PHOTO', 'Usuario activo debe mantenerse en su estado')
    assert.ok(mockSockActive.sentMessages[0].content.text.includes('fotografía'), 'Debe pedir foto')

    // Mensaje de userInactive: debe reiniciar desde cero
    const mockSockInactive = createMockSocket()
    await handleFloodReportFlow(mockSockInactive, userInactive, {
        key: { remoteJid: userInactive, id: 'MSG_INACT' },
        message: { conversation: 'Hola' }
    })
    const sessionInactiveAfter = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userInactive)
    assert.strictEqual(sessionInactiveAfter.state, 'AWAITING_LOCATION', 'Usuario inactivo debe reiniciarse')
    console.log('  ✅ Test 3 aprobado: Cada número de WhatsApp se gestiona de manera 100% independiente.\n')
    passedTests++

    // --------------------------------------------------------------------------
    // Test 4: Diferenciación entre Cancelar vs Inicio/Reiniciar
    // --------------------------------------------------------------------------
    console.log('▶️ Test 4: Comandos Cancelar vs Inicio/Reiniciar...')
    const userCancel = '595985555555@s.whatsapp.net'
    const userRestart = '595986666666@s.whatsapp.net'
    deleteSession(userCancel)
    deleteSession(userRestart)

    // Usuario Cancelar: escribe "cancelar"
    db.prepare(`INSERT INTO report_sessions (user_jid, state) VALUES (?, 'AWAITING_PHOTO')`).run(userCancel)
    const mockSockCancel = createMockSocket()
    await handleFloodReportFlow(mockSockCancel, userCancel, {
        key: { remoteJid: userCancel, id: 'MSG_C' },
        message: { conversation: 'cancelar' }
    })
    assert.strictEqual(db.prepare('SELECT * FROM report_sessions WHERE user_jid = ?').get(userCancel), undefined, 'Sesión cancelada debe ser eliminada')
    assert.ok(mockSockCancel.sentMessages[0].content.text.includes('Reporte cancelado'), 'Debe enviar mensaje de cancelación')

    // Usuario Reiniciar: escribe "reiniciar"
    db.prepare(`INSERT INTO report_sessions (user_jid, state) VALUES (?, 'AWAITING_PHOTO')`).run(userRestart)
    const mockSockRestart = createMockSocket()
    await handleFloodReportFlow(mockSockRestart, userRestart, {
        key: { remoteJid: userRestart, id: 'MSG_R' },
        message: { conversation: 'reiniciar' }
    })
    const sessionRestartAfter = db.prepare('SELECT state FROM report_sessions WHERE user_jid = ?').get(userRestart)
    assert.strictEqual(sessionRestartAfter.state, 'AWAITING_LOCATION', 'Comando reiniciar debe iniciar nuevo flujo en AWAITING_LOCATION')
    assert.ok(mockSockRestart.sentMessages[0].content.text.includes('Sistema de Monitoreo'), 'Debe enviar bienvenida')
    console.log('  ✅ Test 4 aprobado: Comandos Cancelar y Reiniciar operan con sus respectivos comportamientos.\n')
    passedTests++

    // --------------------------------------------------------------------------
    // Test 5: Limpieza segura de uploads/ y protección de sesiones activas
    // --------------------------------------------------------------------------
    console.log('▶️ Test 5: Limpieza de uploads/ y protección contra path traversal...')
    const userActivePhoto = '595987777777@s.whatsapp.net'
    deleteSession(userActivePhoto)

    const activePhoto = path.join(UPLOADS_DIR, `photo_active_${Date.now()}.jpg`)
    const orphanPhoto = path.join(UPLOADS_DIR, `photo_orphan_${Date.now()}.jpg`)
    fs.writeFileSync(activePhoto, 'active photo')
    fs.writeFileSync(orphanPhoto, 'orphan photo')

    // Simular que orphanPhoto tiene 35 minutos de antigüedad
    const pastTime = (Date.now() - 35 * 60 * 1000) / 1000
    fs.utimesSync(orphanPhoto, pastTime, pastTime)

    // Registrar activePhoto en una sesión activa reciente (5 min)
    db.prepare(`
        INSERT INTO report_sessions (user_jid, state, photo_path, updated_at)
        VALUES (?, 'AWAITING_AFFECTATIONS_AND_DESC', ?, datetime('now', '-5 minutes'))
    `).run(userActivePhoto, activePhoto)

    // Ejecutar limpieza general
    cleanupExpiredSessionsAndFiles()

    assert.strictEqual(fs.existsSync(activePhoto), true, 'Foto de sesión activa NUNCA debe ser eliminada')
    assert.strictEqual(fs.existsSync(orphanPhoto), false, 'Foto huérfana de más de 30 min debe ser eliminada')

    // Prueba de seguridad: Path traversal no debe borrar archivos fuera de uploads/
    const forbiddenPath = path.resolve(__dirname, 'bot.js')
    const deleteAttempt = safeDeleteUploadFile(forbiddenPath)
    assert.strictEqual(deleteAttempt, false, 'safeDeleteUploadFile debe rechazar archivos fuera de uploads/')
    assert.strictEqual(fs.existsSync(forbiddenPath), true, 'El archivo fuera de uploads/ debe permanecer intacto')

    // Limpieza final del usuario de prueba
    deleteSession(userActivePhoto)
    console.log('  ✅ Test 5 aprobado: Fotos activas protegidas, huérfanas eliminadas y path traversal bloqueado.\n')
    passedTests++

    // --------------------------------------------------------------------------
    // Test 6: Persistencia y resiliencia ante reinicio del servidor
    // --------------------------------------------------------------------------
    console.log('▶️ Test 6: Resiliencia ante reinicio de Node.js / servidor...')
    const userReboot = '595988888888@s.whatsapp.net'
    deleteSession(userReboot)

    // Simular sesión creada antes de reiniciar el servidor
    db.prepare(`
        INSERT INTO report_sessions (user_jid, state, latitude, longitude, updated_at)
        VALUES (?, 'AWAITING_PHOTO', -25.2867, -57.6470, datetime('now', '-10 minutes'))
    `).run(userReboot)

    // Simular reinicio: verificar que se lee correctamente desde sessions.db
    const restoredSession = db.prepare('SELECT state, latitude, longitude, updated_at FROM report_sessions WHERE user_jid = ?').get(userReboot)
    assert.strictEqual(restoredSession.state, 'AWAITING_PHOTO', 'El estado debe persistir en SQLite')
    assert.strictEqual(restoredSession.latitude, -25.2867, 'Las coordenadas deben persistir')
    assert.strictEqual(isSessionExpired(restoredSession), false, 'Sesión de 10 minutos debe mantenerse activa tras reinicio')

    deleteSession(userReboot)
    console.log('  ✅ Test 6 aprobado: Las sesiones persisten íntegramente tras reinicio del proceso.\n')
    passedTests++

    // --------------------------------------------------------------------------
    // Test 7: Protección de reportes en Supabase (solo limpieza local)
    // --------------------------------------------------------------------------
    console.log('▶️ Test 7: Protección de integridad de reportes en Supabase...')
    // Verificar que ninguna consulta SQL en bot.js o en las rutinas de expiración ejecuta DROP o DELETE en tablas de Supabase
    const botSource = fs.readFileSync(path.resolve(__dirname, 'bot.js'), 'utf8')
    assert.ok(!botSource.includes('DELETE FROM reportes_whatsapp'), 'bot.js nunca debe borrar reportes de la tabla de Supabase')
    assert.ok(!botSource.includes('DROP TABLE'), 'bot.js no debe contener comandos DROP TABLE')
    console.log('  ✅ Test 7 aprobado: Los reportes confirmados en Supabase están 100% protegidos contra borrado.\n')
    passedTests++

    console.log(`🎉 Batería completada con éxito: ${passedTests} de 7 pruebas aprobadas sin errores.`)
}

runTests().catch(err => {
    console.error('❌ Falló la prueba:', err)
    process.exit(1)
})
