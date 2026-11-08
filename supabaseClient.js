// ==============================================================================
// FloodBot - Módulo de Conexión y Persistencia con Supabase
// ==============================================================================
// Este módulo administra la inicialización del cliente de Supabase, la carga
// de fotografías en Supabase Storage (bucket: reportes/whatsapp/) y la inserción
// de reportes validados en la tabla public.reportes_whatsapp.
//
// NOTA DE SEGURIDAD:
// - Nunca quemar credenciales reales en este archivo.
// - Las variables se leen dinámicamente desde .env (ignorado en Git).
// ==============================================================================

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''
const SUPABASE_TABLE_REPORTS = process.env.SUPABASE_TABLE_REPORTS || 'reportes_whatsapp'
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'reportes'
const SUPABASE_STORAGE_FOLDER = process.env.SUPABASE_STORAGE_FOLDER || 'whatsapp'

/**
 * Verifica si las variables mínimas requeridas están definidas en el entorno.
 * @returns {boolean}
 */
function isSupabaseConfigured() {
    return Boolean(
        SUPABASE_URL &&
        SUPABASE_KEY &&
        !SUPABASE_URL.includes('tu-proyecto') &&
        !SUPABASE_KEY.includes('tu-clave')
    )
}

// Inicialización segura del cliente
let supabase = null

if (isSupabaseConfigured()) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: {
                persistSession: false,
                autoRefreshToken: false
            }
        })
    } catch (err) {
        console.error('❌ Error al inicializar cliente Supabase:', err.message)
        supabase = null
    }
}

/**
 * Obtiene la instancia activa del cliente Supabase.
 * @returns {import('@supabase/supabase-js').SupabaseClient | null}
 */
function getSupabaseClient() {
    return supabase
}

/**
 * Obtiene los nombres de tablas y buckets configurados.
 * @returns {object}
 */
function getSupabaseConfig() {
    return {
        isConfigured: isSupabaseConfigured(),
        url: SUPABASE_URL ? SUPABASE_URL.replace(/(https:\/\/[^.]+).*/, '$1.supabase.co') : null,
        keyMasked: SUPABASE_KEY ? (SUPABASE_KEY.substring(0, 6) + '...' + SUPABASE_KEY.substring(SUPABASE_KEY.length - 4)) : null,
        tableReports: SUPABASE_TABLE_REPORTS,
        storageBucket: SUPABASE_STORAGE_BUCKET,
        storageFolder: SUPABASE_STORAGE_FOLDER
    }
}

/**
 * Realiza un test de conectividad seguro contra Supabase (sin escribir datos).
 * Verifica acceso de lectura a la tabla y existencia del bucket de Storage.
 * @returns {Promise<{success: boolean, message: string, details?: object, error?: string}>}
 */
async function testConnection() {
    if (!isSupabaseConfigured() || !supabase) {
        return {
            success: false,
            message: 'Supabase no está configurado. Completá SUPABASE_URL y SUPABASE_KEY en tu archivo .env local.'
        }
    }

    const results = {
        tableCheck: { status: 'pending' },
        bucketCheck: { status: 'pending' }
    }

    try {
        // 1. Verificación de la tabla (solicitud HEAD para conteo sin traer filas)
        const { error: tableError, count } = await supabase
            .from(SUPABASE_TABLE_REPORTS)
            .select('*', { count: 'exact', head: true })

        if (tableError) {
            results.tableCheck = {
                status: 'error',
                error: tableError.message,
                hint: tableError.hint || null
            }
        } else {
            results.tableCheck = {
                status: 'ok',
                table: SUPABASE_TABLE_REPORTS,
                currentRows: count !== null ? count : 0
            }
        }

        // 2. Verificación del bucket de Storage
        const { data: bucketData, error: bucketError } = await supabase
            .storage
            .getBucket(SUPABASE_STORAGE_BUCKET)

        if (bucketError) {
            results.bucketCheck = {
                status: 'error',
                error: bucketError.message
            }
        } else {
            results.bucketCheck = {
                status: 'ok',
                bucket: SUPABASE_STORAGE_BUCKET,
                isPublic: bucketData?.public || false
            }
        }

        const isFullyOk = results.tableCheck.status === 'ok' && results.bucketCheck.status === 'ok'

        return {
            success: isFullyOk,
            message: isFullyOk
                ? 'Conexión con Supabase verificada exitosamente (tabla y bucket accesibles).'
                : 'Conexión parcial con Supabase. Revisá los detalles para ajustar permisos o nombres.',
            details: results
        }

    } catch (err) {
        return {
            success: false,
            message: `Error al conectar con Supabase: ${err.message}`,
            details: results,
            error: err.message
        }
    }
}

/**
 * PASO 5: Sube una fotografía local de reporte a Supabase Storage.
 * @param {string} localFilePath - Ruta local de la imagen en uploads/.
 * @param {string} [customFilename] - Nombre de archivo personalizado opcional.
 * @returns {Promise<{success: boolean, publicUrl?: string, storagePath?: string, error?: string}>}
 */
async function uploadReportPhoto(localFilePath, customFilename = null) {
    if (!isSupabaseConfigured() || !supabase) {
        return { success: false, error: 'Supabase no está configurado.' }
    }

    if (!fs.existsSync(localFilePath)) {
        return { success: false, error: `El archivo local no existe: ${localFilePath}` }
    }

    try {
        const fileBuffer = fs.readFileSync(localFilePath)
        const filename = customFilename || path.basename(localFilePath)
        const storagePath = `${SUPABASE_STORAGE_FOLDER}/${filename}`

        // Subir al bucket con sobrescritura habilitada
        const { error: uploadError } = await supabase.storage
            .from(SUPABASE_STORAGE_BUCKET)
            .upload(storagePath, fileBuffer, {
                contentType: 'image/jpeg',
                upsert: true
            })

        if (uploadError) {
            return { success: false, error: uploadError.message }
        }

        // Obtener la URL pública del objeto almacenado
        const { data: urlData } = supabase.storage
            .from(SUPABASE_STORAGE_BUCKET)
            .getPublicUrl(storagePath)

        return {
            success: true,
            publicUrl: urlData?.publicUrl || null,
            storagePath
        }
    } catch (err) {
        return { success: false, error: err.message }
    }
}

/**
 * PASO 6: Inserta un registro en la tabla public.reportes_whatsapp.
 * Se adapta al esquema exacto configurado en la base de datos de Supabase.
 * @param {object} reportData - Datos del reporte.
 * @param {number} reportData.latitude - Latitud GPS.
 * @param {number} reportData.longitude - Longitud GPS.
 * @param {string} [reportData.description] - Descripción cualitativa.
 * @param {string} [reportData.photoUrl] - URL pública en Supabase Storage.
 * @param {string[]|string} [reportData.affectations] - Categorías de afectación.
 * @param {string} [reportData.estado] - Estado inicial ('pendiente' por omisión).
 * @param {string} [reportData.archivo_tipo] - Tipo MIME ('image/jpeg').
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function insertReportRecord(reportData) {
    if (!isSupabaseConfigured() || !supabase) {
        return { success: false, error: 'Supabase no está configurado.' }
    }

    try {
        // Asegurar que afectaciones sea un array de strings para la columna text[]
        let afectacionesArray = []
        if (Array.isArray(reportData.afectaciones)) {
            afectacionesArray = reportData.afectaciones
        } else if (Array.isArray(reportData.affectations)) {
            afectacionesArray = reportData.affectations
        } else if (Array.isArray(reportData.selected_affectations)) {
            afectacionesArray = reportData.selected_affectations
        } else if (typeof reportData.selected_affectations === 'string') {
            try {
                const parsed = JSON.parse(reportData.selected_affectations)
                afectacionesArray = Array.isArray(parsed) ? parsed : []
            } catch (e) {
                afectacionesArray = []
            }
        }

        const lat = Number(reportData.latitud ?? reportData.latitude)
        const lng = Number(reportData.longitud ?? reportData.longitude)

        // Validación obligatoria: imagen_url no puede ser nula ni vacía
        const photoUrl = reportData.imagen_url ?? reportData.photoUrl ?? null
        if (!photoUrl || typeof photoUrl !== 'string' || !photoUrl.startsWith('http')) {
            return {
                success: false,
                error: 'Fotografía obligatoria: no se permite registrar reportes en Supabase sin imagen_url válida.'
            }
        }

        const row = {
            latitud: isNaN(lat) ? null : lat,
            longitud: isNaN(lng) ? null : lng,
            descripcion: reportData.descripcion ?? reportData.description ?? 'Sin descripción',
            imagen_url: photoUrl,
            estado: reportData.estado || 'pendiente',
            afectaciones: afectacionesArray,
            archivo_tipo: reportData.archivo_tipo || 'image/jpeg',
            creado_en: reportData.creado_en || new Date().toISOString()
        }

        // Si se provee id (UUID persistente), asignarlo explícitamente a la fila
        if (reportData.id) {
            row.id = reportData.id
        }

        // Si row.id está presente, usar upsert con onConflict: 'id' para garantizar idempotencia total ante reintentos
        const query = row.id
            ? supabase.from(SUPABASE_TABLE_REPORTS).upsert(row, { onConflict: 'id' }).select()
            : supabase.from(SUPABASE_TABLE_REPORTS).insert(row).select()

        const { data, error } = await query

        if (error) {
            return { success: false, error: error.message }
        }

        return {
            success: true,
            data: data?.[0] || null
        }
    } catch (err) {
        return { success: false, error: err.message }
    }
}

/**
 * PASO 5 y 6 (Orquestador): Sincroniza un reporte completo hacia Supabase:
 * 1. Sube la fotografía a Supabase Storage (si existe en disco local).
 * 2. Inserta el registro con la URL de la imagen en public.reportes_whatsapp.
 * @param {object} sessionData - Datos consolidados de la sesión de reporte.
 * @returns {Promise<{success: boolean, report?: object, publicUrl?: string, error?: string}>}
 */
async function syncReportToSupabase(sessionData) {
    if (!isSupabaseConfigured()) {
        return { success: false, error: 'Supabase no está configurado.' }
    }

    try {
        let photoPublicUrl = null

        // 1. Subir fotografía si la ruta local es válida
        if (sessionData.photo_path && fs.existsSync(sessionData.photo_path)) {
            const uploadRes = await uploadReportPhoto(sessionData.photo_path)
            if (uploadRes.success) {
                photoPublicUrl = uploadRes.publicUrl
            } else {
                console.warn('⚠️ No se pudo subir la foto a Supabase Storage:', uploadRes.error)
            }
        } else if (sessionData.photo_path && sessionData.photo_path.startsWith('http')) {
            // Ya es una URL remota
            photoPublicUrl = sessionData.photo_path
        } else if (sessionData.storage_url) {
            // Reutilizar storage_url persistido
            photoPublicUrl = sessionData.storage_url
        }

        // Impedir reportes sin fotografía: no insertar si no hay evidencia válida
        if (!photoPublicUrl) {
            return {
                success: false,
                error: 'Fotografía obligatoria: el reporte no cuenta con archivo físico local ni storage_url.'
            }
        }

        // 2. Insertar registro en la tabla con id persistente para evitar duplicados
        const insertRes = await insertReportRecord({
            id: sessionData.id,
            latitude: sessionData.latitude,
            longitude: sessionData.longitude,
            description: sessionData.description,
            selected_affectations: sessionData.selected_affectations,
            photoUrl: photoPublicUrl,
            estado: 'pendiente',
            archivo_tipo: 'image/jpeg'
        })

        if (!insertRes.success) {
            return {
                success: false,
                error: insertRes.error,
                publicUrl: photoPublicUrl
            }
        }

        return {
            success: true,
            report: insertRes.data,
            publicUrl: photoPublicUrl
        }
    } catch (err) {
        return {
            success: false,
            error: err.message
        }
    }
}

// Si se ejecuta directamente desde la terminal (`node supabaseClient.js`)
if (require.main === module) {
    console.log('🔍 Verificando configuración y utilidades de Supabase...')
    const config = getSupabaseConfig()
    console.log('📌 Configuración detectada:', {
        Configurado: config.isConfigured ? 'Sí ✅' : 'No ❌',
        URL: config.url || '(no configurada)',
        Clave: config.keyMasked || '(no configurada)',
        Tabla: config.tableReports,
        Bucket: config.storageBucket,
        Carpeta: config.storageFolder
    })

    if (!config.isConfigured) {
        console.log('\n⚠️ Para completar la configuración:')
        console.log('1. Editá el archivo .env en la raíz del proyecto.')
        console.log('2. Asigná los valores reales de SUPABASE_URL y SUPABASE_KEY.')
        console.log('3. Volvé a ejecutar: node supabaseClient.js\n')
    } else {
        console.log('\n🚀 Probando conectividad remota...')
        testConnection().then(res => {
            console.log('Resultado del test:', JSON.stringify(res, null, 2))
        })
    }
}

module.exports = {
    isSupabaseConfigured,
    getSupabaseClient,
    getSupabaseConfig,
    testConnection,
    uploadReportPhoto,
    insertReportRecord,
    syncReportToSupabase,
    SUPABASE_TABLE_REPORTS,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_STORAGE_FOLDER
}
