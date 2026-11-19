# FloodBot — Sistema Autónomo e Interactivo de Monitoreo Ciudadano de Inundaciones

**FloodBot** es un agente conversacional y sistema de sensado ciudadano desarrollado en **Node.js** utilizando la librería **Baileys** para la recepción, estructuración, enriquecimiento y persistencia en la nube (**Supabase**) de reportes de anegamientos e inundaciones urbanas a través de **WhatsApp**.

Este proyecto forma parte de una investigación de tesis de grado en **Ingeniería Mecatrónica**, orientada a la gestión de emergencias hidrometeorológicas, la georreferenciación temprana de incidentes y la participación comunitaria resiliente.

---

## 🌟 Características Principales del Sistema

1. **📍 Doble Método de Captura de Ubicación Geográfica:**
   * **Ubicación Nativa de WhatsApp:** Recepción y validación de coordenadas satelitales en tiempo real (`locationMessage` / `liveLocationMessage`).
   * **Enlaces de Google Maps:** Detección de URLs estándar y acortadas (`maps.app.goo.gl` o `goo.gl/maps`). Extracción precisa de las coordenadas del **marcador del incidente** (`!3d/!4d` o parámetro `q`), descartando las coordenadas del centro de cámara (`/@lat,lng`) para evitar falsos positivos. Protección estricta contra SSRF y redirecciones maliciosas.

2. **📸 Evidencia Fotográfica y Auto-Guardado Progresivo:**
   * La recepción de una fotografía válida descargada en `uploads/` consolida **de forma inmediata** el reporte básico en la base de datos local SQLite (`pending_sync_reports`).
   * El reporte queda resguardado automáticamente: si el usuario no responde las preguntas posteriores, la evidencia fotográfica y las coordenadas ya están a salvo y son sincronizadas con Supabase en segundo plano.

3. **⛈️ Encuesta Interactiva de Afectaciones Urbanas (11 Categorías):**
   * Envío de encuesta nativa multi-selección de WhatsApp con las 11 opciones estandarizadas de la plataforma de monitoreo.
   * Descifrado criptográfico de votos emitidos por el usuario en tiempo real y compatibilidad con selección por texto.

4. **✍️ Descripción Opcional y Cierre Directo:**
   * El ciudadano puede enviar una descripción textual del hecho o escribir `LISTO`/`CONTINUAR` para omitir.
   * Al recibir la descripción o comando de avance, el bot presenta de inmediato el `📋 Resumen de tu reporte` y el mensaje de agradecimiento final con el enlace a la plataforma web cartográfica ([https://monitoreoinundaciones.vercel.app](https://monitoreoinundaciones.vercel.app)), sin requerir encuestas redundantes de confirmación.

5. **⏱️ Gestión Inteligente de Inactividad (15 Minutos):**
   * Si el usuario se desconecta antes de enviar la fotografía, el borrador incompleto y los archivos huérfanos se descartan de forma segura tras 15 minutos, notificando el cierre.
   * Si el usuario ya envió ubicación y fotografía, a los 15 minutos de inactividad se cierra la sesión conversacional enviando el agradecimiento final, **preservando el reporte y la foto intactos** en la base de datos y la nube.

6. **👨‍💼 Modo de Atención Manual por Asesor Humano (Intervención de Operador):**
   * **Detección Automática:** Si un operador humano responde personalmente desde el WhatsApp del bot (desde el teléfono o WhatsApp Web), FloodBot detecta la intervención manual diferenciándola de los ecos propios del bot (`fromMe: true`) gracias a una bitácora de mensajes salientes.
   * **Silenciamiento Total:** El bot cancela mensajes encolados y enmudece de forma estricta para esa conversación específica, sin interferir en los reportes de otros ciudadanos.
   * **Descarte de Borradores Incompletos:** Si existía un borrador sin confirmar previo a la intervención, se descarta para permitir la atención libre; los reportes ya consolidados se mantienen resguardados.
   * **Cierre Estandarizado:** Cuando el asesor envía la frase `Gracias. Reporte recibido`, se finaliza el modo manual y se activa un período de gracia (*cooldown*) de 15 minutos.
   * **Período de Gracia Inmutable (15 min):** Durante los 15 minutos posteriores al cierre, mensajes de cortesía como *"gracias"* u *"ok"* son silenciados sin reiniciar el temporizador. Si el ciudadano escribe `REPORTAR`, se inicia de inmediato un nuevo reporte automático. Al transcurrir los 15 minutos, cualquier mensaje reactiva el bot con la bienvenida habitual.
   * **Persistencia Local:** El estado del asesor se guarda en SQLite (`advisor_sessions`), sobreviviendo a reinicios y reconexiones del servidor.

7. **🛡️ Alta Disponibilidad, Resiliencia y Cero Puertos Expuestos:**
   * Comunicación WebSocket segura saliente (WSS, puerto 443) con los servidores oficiales de WhatsApp. Sin necesidad de abrir puertos TCP/IP ni exponer servidores web en el host.
   * Sistema de cola saliente con espaciado humano aleatorio (800 - 2200 ms) para evitar suspensiones y bloqueos por spam de WhatsApp.
   * Reintentos de sincronización con Supabase mediante retroceso exponencial (*exponential backoff*).

---

## 🏗️ Arquitectura del Sistema

```
                       ┌──────────────────────────────────────────────┐
                       │               CIUDADANO / ASESOR             │
                       │             (Cliente WhatsApp Móvil)         │
                       └──────────────────────┬───────────────────────┘
                                              │ (Cifrado WSS / Ruido)
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ SERVIDOR LOCAL / LABORATORIO (Node.js)                                                  │
│                                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │ Librería Baileys (Socket WhatsApp Multi-Device)                                 │   │
│   │ ├── Extractor de mensajes y firmas criptográficas                               │   │
│   │ └── Bitácora de mensajes salientes del bot (Diferenciación de Asesor)           │   │
│   └────────────────────────┬────────────────────────────────┬───────────────────────┘   │
│                            │ Mensajes Entrantes             │ Envío de Mensajes         │
│                            ▼                                ▲                           │
│   ┌─────────────────────────────────────────────────────────┴───────────────────────┐   │
│   │ Máquina de Estados Finitos (FSM) y Gestor de Diálogo                            │   │
│   │ ├── Ingesta de Ubicación (GPS Nativo / Google Maps Link Parser + Anti-SSRF)     │   │
│   │ ├── Descarga de Imágenes a uploads/                                             │   │
│   │ ├── Decodificación de Votos de Encuestas                                        │   │
│   │ ├── Gestor de Inactividad (15 min) y Comandos de Cancelación                    │   │
│   │ └── Modo Asesor (Activación manual, Cooldown de 15 min, Silenciamiento)         │   │
│   └────────────────────────┬────────────────────────────────┬───────────────────────┘   │
│                            │                                │                           │
│                            ▼                                ▼                           │
│   ┌──────────────────────────────────┐            ┌─────────────────────────────────┐   │
│   │ Base de Datos SQLite             │            │ Cola de Envíos (MessageQueue)   │   │
│   │ (sessions.db - better-sqlite3)   │            │ ├── Espaciado humano (800-2200ms)│  │
│   │ ├── report_sessions              │            │ ├── Rate Limiting anti-spam     │   │
│   │ ├── pending_sync_reports         │            │ └── Cancelación selectiva (JID) │   │
│   │ ├── advisor_sessions             │            └─────────────────────────────────┘   │
│   │ ├── bot_outgoing_messages        │                                                  │
│   │ └── audit_logs                   │                                                  │
│   └────────────────────────┬─────────┘                                                  │
│                            │ Workers en Segundo Plano                                   │
└────────────────────────────┼────────────────────────────────────────────────────────────┘
                             │ HTTPS / REST API
                             ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ NUBE SUPABASE (Infraestructura Remota)                                                  │
│ ├── Supabase Storage: Bucket 'reportes' (subcarpeta 'whatsapp/')                         │
│ └── PostgreSQL: Tabla 'public.reportes_whatsapp'                                        │
│                                                                                         │
│ ───► Conectado a la Plataforma Web GIS: https://monitoreoinundaciones.vercel.app        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 💬 Flujo Conversacional Estructurado

El diálogo de FloodBot sigue una secuencia rigurosa para asegurar la calidad de la información:

```
[Ciudadano] ──► "Hola" / "Quiero reportar"
[FloodBot]  ──► 🌊 ¡Hola! Bienvenido a FloodBot...
                 Por favor, compartí la ubicación del anegamiento (GPS o enlace de Google Maps):
                
[Ciudadano] ──► [Envía Ubicación GPS de WhatsApp O Enlace de Google Maps]
[FloodBot]  ──► 📍 Ubicación registrada (-25.2981, -57.5319).
                 Ahora enviá una fotografía del lugar donde se observe el agua:

[Ciudadano] ──► [Envía Fotografía]
                 ⚙️ (El sistema guarda automáticamente el reporte básico en SQLite y encola para Supabase)
[FloodBot]  ──► 📸 ¡Foto recibida con éxito!
                 ⛈️ [Encuesta Interactiva con 11 afectaciones]
                 ✍️ *Descripción opcional*: Si querés, contanos más detalles de la situación:
                 *(Escribí tu mensaje o enviá "LISTO" para finalizar)*

[Ciudadano] ──► "El agua llega al cordón de la vereda y tapa los desagües" (o "LISTO")
                 ⚙️ (Se enriquecen las afectaciones y la descripción en el reporte guardado)
[FloodBot]  ──► 📋 *Resumen de tu reporte*
                 📍 Ubicación: -25.298100, -57.531900
                 📸 Fotografía: Recibida ✅
                 ⛈️ Afectaciones: Calle inundada, Acumulación de basura
                 ✍️ Descripción: El agua llega al cordón de la vereda...

                 ✅ *¡Muchas gracias por colaborar con tu comunidad!*
                 Tu reporte fue registrado correctamente en el sistema de monitoreo.
                 Podés ver los reportes en el mapa interactivo:
                 🌐 https://monitoreoinundaciones.vercel.app
                 ──────────────────────────────────────────
                 Si querés hacer otro reporte, escribí *REPORTAR*.
```

---

## 👨‍💼 Manual de Operación: Atención Manual por Asesor

FloodBot permite que un operador o asesor humano intervenga en cualquier conversación desde su propio cliente de WhatsApp (teléfono o WhatsApp Web), tomando el control sin que el bot interfiera.

### 1. ¿Cómo activar la atención manual?
Simplemente escribí un mensaje desde tu WhatsApp al ciudadano que está interactuando con el bot:
> *"Hola, te habla un asesor de guardia. Te voy a ayudar con tu caso."*

* **Qué hace FloodBot automáticamente:**
  1. Detecta que el mensaje saliente proviene de una persona y no del código del bot.
  2. Cancela inmediatamente cualquier mensaje del bot que estuviera esperando en cola.
  3. Pone al bot en silencio absoluto para esa conversación.
  4. Si el ciudadano tenía un borrador incompleto (no había mandado foto), lo descarta junto con los temporales para dar paso a la atención manual. Si ya había confirmado un reporte con foto, este se mantiene intacto.
  5. Desactiva el temporizador de inactividad de 15 minutos para que la conversación no se cierre mientras dialogás con el ciudadano.
  6. **No envía ningún reporte de la conversación manual a Supabase** (el operador cargará los datos manualmente en el panel web si corresponde).

### 2. ¿Cómo finalizar la atención manual?
Cuando hayas terminado de atender al ciudadano, enviá el siguiente mensaje de cierre (o cualquier variante similar):

> **Gracias. Reporte recibido.**
> 
> Tu reporte ha sido recibido correctamente.
> Si querés realizar otro reporte, escribí **REPORTAR** para iniciar uno nuevo.

* **Reconocimiento de cierre:** FloodBot detecta la frase clave `Gracias. Reporte recibido` (sin importar mayúsculas, minúsculas, puntos o tildes).
* **El bot NO envía este mensaje por vos:** Debés enviarlo vos como asesor desde tu WhatsApp.

### 3. ¿Qué ocurre después de enviar el mensaje de cierre? (Período de Gracia)
1. El bot pasa a un estado de **enfriamiento (*cooldown*) de 15 minutos exactos**.
2. **Silencio de cortesía:** Si durante estos 15 minutos el ciudadano responde *"Muchas gracias"*, *"Ok"*, *"Entendido"*, el bot **no contesta nada** y el temporizador **no se reinicia**.
3. **Reinicio voluntario:** Si en cualquier momento el ciudadano escribe la palabra clave `REPORTAR`, el período de gracia se cancela al instante y el bot inicia un nuevo flujo automático.
4. **Restauración automática:** Transcurridos los 15 minutos desde el mensaje del asesor, la conversación vuelve al estado normal: el próximo mensaje del ciudadano iniciará el diálogo estándar de bienvenida.

---

## 🗄️ Estructura de la Base de Datos Local (`sessions.db`)

FloodBot utiliza SQLite mediante `better-sqlite3` para garantizar persistencia transaccional y resistencia ante cortes de energía o reinicios del proceso:

| Tabla | Propósito | Columnas Clave |
|---|---|---|
| `report_sessions` | Estado de la sesión conversacional activa de cada usuario. | `user_jid` (PK), `state`, `latitude`, `longitude`, `selected_affectations`, `photo_path`, `description`, `report_id`, `updated_at` |
| `pending_sync_reports` | Cola resiliente de reportes pendientes de envío a Supabase Storage y PostgreSQL. | `id` (PK, UUID), `user_jid`, `latitude`, `longitude`, `selected_affectations`, `photo_path`, `storage_url`, `status`, `attempts`, `next_retry_at` |
| `advisor_sessions` | Control del modo asesor humano y período de gracia (*cooldown*). | `user_jid` (PK), `status` (`'ACTIVE'` / `'COOLDOWN'`), `started_at`, `closed_at`, `closed_at_ms` |
| `bot_outgoing_messages` | Bitácora de identificadores de mensajes salientes emitidos por el bot para diferenciarlos del operador. | `id` (PK), `created_at` |
| `audit_logs` | Registro histórico local de auditoría y diagnóstico del sistema. | `id` (PK), `timestamp`, `type`, `message` |

---

## 🧪 Batería de Pruebas Automatizadas (52 Tests)

El sistema cuenta con una exhaustiva suite de pruebas unitarias e integrales en [`test_expiration.js`](test_expiration.js) que valida la totalidad de los flujos, condiciones de borde y seguridad sin afectar la base de datos de producción:

```bash
npm test
```

### Resumen de Cobertura de las 52 Pruebas:
* **Tests 01 al 09:** Validación de transiciones FSM, coordenadas satelitales, rechazo de formatos no válidos y geocercas.
* **Tests 10 al 19:** Descarga de imágenes binarias, descifrado de votos en encuestas interactivas, descripción y descarte seguro de archivos temporales.
* **Tests 20 al 30:** Auto-guardado progresivo al recibir la foto, preservación del reporte ante inactividad (>15 min), finalización directa con resumen y comandos de cancelación (`0`, `CANCELAR`, `SALIR`).
* **Tests 31 al 40:** Recepción de ubicaciones por Google Maps (enlaces directos, parámetros `q`, enlaces cortos `maps.app.goo.gl`), resolución segura de redirecciones, protección contra SSRF y prioridad estricta de marcadores sobre centro de cámara (`/@lat,lng`).
* **Tests 41 al 52:** Modo de atención manual por asesor humano:
  - Detección de mensajes manuales y diferenciación con mensajes del bot (`fromMe: true`).
  - Silenciamiento del bot y cancelación de colas de envío.
  - Aislamiento: no envío de conversaciones manuales a Supabase.
  - Reconocimiento de frase de cierre `Gracias. Reporte recibido`.
  - Cooldown de 15 minutos (inmunidad a respuestas de cortesía, sin reinicio de temporizador).
  - Comando `REPORTAR` para reactivación inmediata durante el cooldown.
  - Auto-restauración tras 15 minutos exactos.
  - Persistencia de sesiones de asesor en SQLite ante reinicios del servidor.
  - Protección de reportes consolidados y descarte selectivo de borradores incompletos.

---

## ⚡ Guía de Inicio Rápido

### En Windows (Desarrollo y Pruebas Locales)
```cmd
# 1. Posicionarse en la carpeta del bot
cd /d C:\Users\Usuario\Documents\baileys-whatsapp

# 2. Instalar dependencias (solo la primera vez)
npm install

# 3. Ejecutar las pruebas automatizadas para verificar integridad
npm test

# 4. Probar conectividad con Supabase
node supabaseClient.js

# 5. Iniciar el bot en la consola
node bot.js
```

### En Servidor Linux (Producción y Laboratorio)
> 📖 Para la guía completa y detallada de instalación en Linux, consulta [**INSTALACION.md**](INSTALACION.md).

```bash
# 1. Clonar el repositorio y acceder
git clone https://github.com/PilarEve/floodbot-baileys-whatsapp.git
cd floodbot-baileys-whatsapp

# 2. Configurar variables de entorno en .env
nano .env

# 3. Instalar dependencias y correr tests
npm install
npm test

# 4. Vincular por Pairing Code (primer arranque)
node bot.js

# 5. Ejecutar permanentemente en segundo plano con PM2 o nohup
nohup node bot.js > bot.log 2>&1 &
```

---

## 📚 Documentación Técnica Detallada

Para profundizar en la arquitectura mecatrónica, diagramas de red y manuales de laboratorio:

* 📘 [**DOCUMENTACION_SISTEMA.md**](DOCUMENTACION_SISTEMA.md): Manual técnico integral de ingeniería (arquitectura, FSM, SSRF, colas y sincronización).
* 🚀 [**INSTALACION.md**](INSTALACION.md): Manual paso a paso para el despliegue permanente en el servidor Linux del laboratorio.
* 🛡️ [**AUDITORIA_PRE_DESPLIEGUE.md**](AUDITORIA_PRE_DESPLIEGUE.md): Informe técnico de auditoría y verificación de seguridad.
* 📁 [**docs/README.md**](docs/README.md): Centro de documentación didáctica con 17 capítulos temáticos y rutas de aprendizaje para tesis de grado.

---

## 📄 Licencia y Reconocimientos
Desarrollado como proyecto de tesis de grado en **Ingeniería Mecatrónica**. Diseñado para el beneficio de la comunidad y la resiliencia urbana ante el cambio climático.
