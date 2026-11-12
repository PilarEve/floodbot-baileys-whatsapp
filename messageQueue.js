// ==============================================================================
// FloodBot - Módulo de Cola de Mensajes Salientes y Rate Limiting
// ==============================================================================
// Gestiona el despacho centralizado de mensajes salientes mediante Baileys,
// aplicando un intervalo mínimo (Rate Limiting) para evitar ráfagas, preservando
// el orden FIFO estricto por usuario y garantizando el uso del socket activo.
// ==============================================================================

const OUTGOING_RATE_LIMIT_MS = parseInt(process.env.OUTGOING_RATE_LIMIT_MS, 10) || 350
const MAX_QUEUE_AGE_MS = parseInt(process.env.MAX_QUEUE_AGE_MS, 10) || (5 * 60 * 1000) // 5 minutos

class MessageQueue {
    /**
     * @param {number} rateLimitMs - Intervalo mínimo entre envíos consecutivos en milisegundos.
     * @param {number} maxAgeMs - Tiempo máximo de retención en cola antes de expirar por desconexión prolongada.
     */
    constructor(rateLimitMs = OUTGOING_RATE_LIMIT_MS, maxAgeMs = MAX_QUEUE_AGE_MS) {
        this.rateLimitMs = rateLimitMs
        this.maxAgeMs = maxAgeMs
        this.queue = []
        this.isProcessing = false
        this.isPaused = false
        this.currentSocket = null
        this.lastDispatchTime = 0
    }

    /**
     * Actualiza la referencia del socket activo (especialmente tras reconexión).
     * @param {object} sock - Instancia activa del socket de Baileys.
     */
    setSocket(sock) {
        this.currentSocket = sock
        if (sock && !this.isPaused) {
            this.processQueue()
        }
    }

    /**
     * Obtiene el socket activo actual.
     * @returns {object|null}
     */
    getSocket() {
        return this.currentSocket
    }

    /**
     * Pausa el despacho de la cola (por ejemplo, ante eventos connection.close).
     */
    pause() {
        this.isPaused = true
    }

    /**
     * Reanuda el despacho de la cola (por ejemplo, ante eventos connection.open).
     */
    resume() {
        this.isPaused = false
        this.processQueue()
    }

    /**
     * Obtiene la cantidad de mensajes actualmente en espera.
     * @returns {number}
     */
    getQueueLength() {
        return this.queue.length
    }

    /**
     * Encola un mensaje para ser enviado a través del socket activo respetando el Rate Limiting.
     * NO guarda referencias fijas a sockets obsoletos; utiliza siempre el socket activo en el momento del envío.
     *
     * @param {string} jid - Destinatario de WhatsApp.
     * @param {object} content - Contenido del mensaje de Baileys (texto, encuesta, etc.).
     * @param {object} [options] - Opciones adicionales de Baileys.
     * @returns {Promise<object>} Promesa que resuelve con el resultado exacto de sock.sendMessage().
     */
    enqueue(jid, content, options = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                jid,
                content,
                options,
                resolve,
                reject,
                enqueuedAt: Date.now()
            })
            this.processQueue()
        })
    }

    /**
     * Bucle de procesamiento de la cola global en memoria.
     */
    async processQueue() {
        if (this.isProcessing || this.isPaused) return
        this.isProcessing = true

        try {
            while (this.queue.length > 0 && !this.isPaused) {
                // Control de velocidad: verificar tiempo transcurrido desde el último envío
                const now = Date.now()
                const timeSinceLast = now - this.lastDispatchTime
                if (this.rateLimitMs > 0 && timeSinceLast < this.rateLimitMs) {
                    const waitTime = this.rateLimitMs - timeSinceLast
                    await new Promise(r => setTimeout(r, waitTime))
                    if (this.isPaused) break
                }

                const item = this.queue.shift()
                if (!item) continue

                // Comprobación de desconexión prolongada: no descartar silenciosamente, rechazar con error explícito
                if (this.maxAgeMs > 0 && (Date.now() - item.enqueuedAt) > this.maxAgeMs) {
                    item.reject(new Error(`Mensaje saliente expirado tras desconexión prolongada (> ${Math.round(this.maxAgeMs / 1000)}s)`))
                    continue
                }

                // Utilizar SIEMPRE el socket actualmente activo (nunca referencias obsoletas)
                const activeSock = this.getSocket()
                if (!activeSock) {
                    // Si no hay conexión activa, devolver el elemento al inicio y pausar la cola
                    this.queue.unshift(item)
                    this.isPaused = true
                    break
                }

                try {
                    const result = await activeSock.sendMessage(item.jid, item.content, item.options)
                    this.lastDispatchTime = Date.now()
                    item.resolve(result)
                } catch (err) {
                    this.lastDispatchTime = Date.now()
                    item.reject(err)
                }
            }
        } finally {
            this.isProcessing = false
        }
    }
}

// Instancia global por omisión
const defaultQueue = new MessageQueue()

module.exports = {
    MessageQueue,
    defaultQueue,
    OUTGOING_RATE_LIMIT_MS,
    MAX_QUEUE_AGE_MS
}

