# INFORME DE AUDITORÍA TÉCNICA Y DE SEGURIDAD PRE-DESPLIEGUE
## Proyecto: FloodBot (Bot de WhatsApp para Monitoreo Ciudadano de Inundaciones)
**Destino de Despliegue:** Servidor Linux — Laboratorio Universitario  
**Fecha de Auditoría:** 10 de Noviembre de 2026  
**Tipo de Auditoría:** Estática de Código, Dependencias, Arquitectura y Seguridad Operativa (Solo Lectura)  
**Estado del Repositorio Auditado:** Commit `17e4ed8` | Rama: `main` | 14/14 Pruebas Automatizadas Aprobadas  

---

## 1. Resumen Ejecutivo del Estado del Proyecto

FloodBot es un agente conversacional autónomo desarrollado sobre **Node.js**, la librería **Baileys** (vía WebSocket seguro WSS saliente a WhatsApp), base de datos local **better-sqlite3** y persistencia en la nube mediante **Supabase** (PostgreSQL y Storage). Su propósito es recibir reportes ciudadanos de inundaciones urbanas capturando coordenadas GPS, fotografías de evidencia, afectaciones tipificadas y descripciones cualitativas.

### Principales Fortalezas Comprobadas:
1. **Ausencia Total de Servicios y Puertos Expuestos:** El bot no levanta ningún servidor HTTP, Express ni sockets de escucha de red. Toda la comunicación es estrictamente como **cliente saliente (outbound)** hacia WhatsApp (puerto 443 WSS) y Supabase (puerto 443 HTTPS). No representa una superficie de ataque expuesta a internet.
2. **Defensa Rigurosa contra Path Traversal:** La función de borrado de archivos `safeDeleteUploadFile` implementa `fs.realpathSync` y comprobación canónica estricta contra `uploads/`, impidiendo la manipulación de rutas relativas o symlinks.
3. **Idempotencia y Resiliencia en Sincronización:** El uso de UUIDs compartidos y la cola local `pending_sync_reports` evitan reportes duplicados y pérdidas de datos ante caídas de red o fallos de Supabase.
4. **Validación Defensiva de Evidencia:** El sistema impide estrictamente registrar reportes en Supabase si no cuentan con una fotografía válida subida a Storage.
5. **Calidad de Pruebas Automatizadas:** La suite de pruebas (`npm test`) ejecuta 14 escenarios aislados sin tocar las bases ni directorios reales, aprobando el 100% de las verificaciones.

### Aspectos que Requieren Corrección Previa al Despliegue:
A pesar de su robusta lógica de negocio, se han identificado **riesgos operativos y de seguridad** que podrían comprometer la estabilidad a largo plazo (semanas/meses de ejecución continua desatendida) en un servidor Linux compartido:
- Crecimiento sin límite de la tabla local `audit_logs` en SQLite.
- Acumulación indefinida de claves en mapas en memoria (`recentTriggers` y `pollRegistry`).
- Falta de un mecanismo de bloqueo de instancia única (PID lock), lo que arriesga conflictos destructivos de sesión si se ejecuta dos veces.
- Exposición de clave con privilegios administrativos (`service_role`) en el archivo `.env`.
- Recomendación de comandos no seguros (`nohup` y `pkill -f`) en la guía de instalación `INSTALACION.md`.

**Calificación Global:** **APTO CON CORRECCIONES**.

---

## 2. Matriz de Vulnerabilidades y Riesgos Identificados

| ID | Riesgo / Hallazgo | Nivel | Ubicación (Archivo y Líneas) | Consecuencia Potencial para el Servidor | Solución Recomendada |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **VULN-01** | Crecimiento descontrolado de `audit_logs` en SQLite | **ALTO** | [`bot.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L110-L116) | Agotamiento del espacio en disco por acumulación infinita de logs de cada mensaje e interacción. | Implementar poda automática de registros conservando últimos 7 días o máx 10.000 filas. |
| **VULN-02** | Fuga de memoria (Memory Leak) en Maps globales | **ALTO** | [`bot.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L487), [`#L537-L542`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L537-L542), [`#L649-L653`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L649-L653), [`#L695-L704`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L695-L704) | Degradación de memoria RAM y caída por OOM (*Out Of Memory*) tras meses de operación con miles de ciudadanos. | Implementar limpieza periódica (TTL) o estructura LRU para `recentTriggers` y `pollRegistry`. |
| **VULN-03** | Falta de bloqueo de proceso único (Mutex / PID Lock) | **ALTO** | [`bot.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L1107-L1135), [`#L1279-L1283`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L1279-L1283) | Si se inicia dos veces, WhatsApp revoca la sesión con error 440 en bucle agresivo y bloquea SQLite (`SQLITE_BUSY`). | Implementar archivo de bloqueo (`bot.lock`) al arrancar el proceso con salida limpia si ya existe. |
| **VULN-04** | Exposición de credencial administrativa (`service_role`) | **ALTO** | [`.env`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/.env#L7), [`supabaseClient.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/supabaseClient.js#L18-L52) | Compromiso de todo el proyecto Supabase si un atacante lee el `.env` en el servidor del laboratorio (bypassea RLS). | Reemplazar por clave `anon` con políticas RLS de solo inserción o restringir permisos de archivo a `600`. |
| **VULN-05** | Falta de validación de Magic Bytes y tamaño en imágenes | **MEDIO** | [`bot.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L960-L974) | Un usuario podría saturar la memoria enviando archivos pesados o formatos binarios corruptos en `AWAITING_PHOTO`. | Validar tamaño máximo de buffer (ej. 10MB) y verificar cabecera JPEG (`0xFF 0xD8 0xFF`) antes de guardar. |
| **VULN-06** | Reconexión con retardo fijo (5s) sin jitter ni retroceso | **MEDIO** | [`bot.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L1176-L1178) | Ante una caída prolongada de red o bloqueo de WhatsApp, reintentos constantes cada 5s pueden provocar ban de IP. | Implementar retroceso exponencial (Backoff) con jitter para la reconexión del socket (5s a 5 min). |
| **VULN-07** | Gestión de procesos insegura en documentación (`nohup`/`pkill`) | **MEDIO** | [`INSTALACION.md`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/INSTALACION.md#L123-L145) | `pkill -f "node bot.js"` puede terminar procesos de otros investigadores en el laboratorio; `nohup` no rota logs ni reinicia en boot. | Reemplazar las instrucciones de `nohup` por el servicio `systemd` ya preparado en `docs/13-despliegue-servidor.md`. |
| **VULN-08** | Almacenamiento de números de teléfono (PII) en claro en SQLite | **MEDIO** | [`bot.js`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L578-L590), [`#L712-L725`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/bot.js#L712-L725) | Exposición de números de ciudadanos ante otros usuarios locales con acceso de lectura en el servidor Linux. | Forzar `umask 077` en el servicio y permisos `chmod 600` en `sessions.db` y `auth_info_baileys/`. |
| **VULN-09** | Dependencia en versión Release Candidate (`@whiskeysockets/baileys`) | **BAJO** | [`package.json`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/package.json#L13), [`package-lock.json`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/package-lock.json) | Modificaciones unilaterales de protocolo por parte de Meta pueden romper el bot y requerir actualización rápida. | Documentar procedimiento de actualización de Baileys y monitoreo de issues en GitHub. |
| **VULN-10** | Exclusión de `docs/` en `.gitignore` | **BAJO** | [`.gitignore`](file:///c:/Users/Usuario/Documents/baileys-whatsapp/.gitignore#L38) | Al clonar el repositorio en el servidor Linux, la carpeta `docs/` no existirá si no se gestiona explícitamente. | Decidir si la documentación técnica debe incluirse en el repositorio de entrega al profesor. |

---

## 3. Análisis Detallado por Áreas

### 3.1. Seguridad del Servidor Linux

1. **Evaluación de Código Malicioso y Ejecución de Comandos:**
   - **Confirmado Seguro:** No se detectó ninguna invocación de `child_process.exec`, `child_process.spawn`, `eval()`, `new Function()` ni acceso directo al shell del sistema operativo.
   - El código interactúa con el sistema operativo exclusivamente mediante las APIs estándar de Node.js (`fs`, `path`, `crypto`, `readline`).
2. **Archivos y Directorios Creados, Modificados o Eliminados:**
   - `uploads/`: Crea archivos temporales con nombre seguro y pseudoaleatorio (`photo_<sanitizedJid>_<timestamp>_<randomHex>.jpg`). Se eliminan tras la sincronización o transcurridos 30 minutos de inactividad.
   - `sessions.db`, `sessions.db-journal`, `sessions.db-wal`: Base SQLite gestionada por `better-sqlite3`.
   - `auth_info_baileys/`: Claves criptográficas y tokens de sesión de WhatsApp.
   - **Garantía de Seguridad:** Ninguna función escribe ni borra archivos fuera de la raíz del proyecto. `safeDeleteUploadFile` cuenta con un blindaje estricto contra Path Traversal (`fs.realpathSync` + comparación canónica de prefijos).
3. **Puertos y Servicios de Red:**
   - **Confirmado Seguro:** El bot **no abre ningún puerto TCP ni UDP**. No hay servidores HTTP, Express ni listeners locales.
   - *Nota de Limpieza:* La variable `PORT=3001` presente en `.env` es un remanente inerte que no se consume en ningún archivo del código.
4. **Privilegios y Usuario del Sistema:**
   - El bot **no requiere privilegios de administrador (`root` / `sudo`)** para ninguna de sus tareas.
   - Debe ejecutarse obligatoriamente bajo un usuario de sistema dedicado y sin privilegios (por ejemplo `floodbot`), con permisos de lectura y escritura restringidos exclusivamente a su directorio de instalación.
5. **Consumo de Recursos (CPU, Memoria y Almacenamiento):**
   - **CPU:** El consumo es mínimo en reposo (I/O orientada a eventos).
   - **Memoria (Riesgo Confirmado):** `global.recentTriggers` y `global.pollRegistry` son instancias de `Map` que retienen identificadores de usuarios y encuestas indefinidamente. En un entorno productivo con miles de interacciones, causarán fuga de memoria gradual.
   - **Almacenamiento (Riesgo Confirmado):** La tabla `audit_logs` en `sessions.db` acumula cada evento sin purga ni rotación.

---

### 3.2. Auditoría de Dependencias

Se analizó `package.json` y `package-lock.json`:
- **Dependencias Directas:**
  - `@hapi/boom@10.0.1`: Manejo de errores de protocolo HTTP/Baileys.
  - `@supabase/supabase-js@2.117.3`: Cliente oficial de Supabase.
  - `@whiskeysockets/baileys@7.0.0-rc.9` (resuelve a `rc.14` en lockfile): Cliente de WhatsApp Web.
  - `better-sqlite3@12.6.2`: Motor SQLite local embebido en C++.
  - `dotenv@18.0.7`: Carga de variables de entorno desde `.env`.
  - `pino@10.2.0`: Motor de registro de logs ultrarrápido.
- **Resultado de `npm audit`:**
  - **0 vulnerabilidades detectadas** (0 critical, 0 high, 0 moderate, 0 low) sobre un total de 143 paquetes (115 de producción, 27 opcionales y 29 peer dependencies).
- **Scripts de Instalación Identificados:**
  - `baileys`: `preinstall: "node ./engine-requirements.js"` (Verifica que Node sea >= 20.0.0).
  - `better-sqlite3`: `install: "prebuild-install || node-gyp rebuild --release"` (Descarga binario compilado o compila vía node-gyp).
  - `protobufjs`: `postinstall: "node scripts/postinstall"` (Comprobación de coherencia interna).
  - *Dictamen de Scripts:* No contienen llamadas a servidores no confiables ni actividades maliciosas.
- **Riesgos Tecnológicos Específicos:**
  - **Baileys:** Es una librería basada en ingeniería inversa del protocolo WebSocket de WhatsApp Web. Al estar en versión Release Candidate (`rc.14`), está sujeta a potenciales cambios repentinos cuando Meta actualiza sus protocolos.
  - **better-sqlite3:** Requiere dependencias nativas del sistema operativo en Linux. Si el servidor carece de herramientas de compilación (`python3`, `make`, `g++`), la instalación fallará a menos que la versión de Node coincida con los binarios preconstruidos.

---

### 3.3. Seguridad de WhatsApp y Supabase

1. **Protección de `auth_info_baileys/`:**
   - Este directorio almacena las llaves privadas de Curve25519, claves Noise, tokens AES y el archivo `creds.json`.
   - **Impacto:** Si un usuario no autorizado lee esta carpeta, puede clonar la identidad del bot de WhatsApp y leer o enviar mensajes en su nombre.
   - **Medida Requerida:** Permisos estrictos en Linux: `chmod 700 auth_info_baileys` y `chmod 600 auth_info_baileys/*`.
2. **Protección de Credenciales en `.env`:**
   - La clave actual en `.env` tiene formato `sb_secret_...` (clave de servicio / service_role).
   - **Riesgo:** La clave `service_role` ignora las políticas de Row Level Security (RLS) de Supabase. Si el servidor del laboratorio es comprometido, un atacante obtiene control total de la base de datos remota de Supabase.
   - **Medida Requerida:** Se debe crear una política de RLS específica para la tabla `reportes_whatsapp` (permitiendo únicamente `INSERT`) y utilizar una clave con privilegios mínimos (`anon key`), o proteger de forma extrema el archivo `.env` (`chmod 600`).
3. **Privacidad y Datos de Ciudadanos (PII):**
   - El bot guarda en `sessions.db` el número de WhatsApp de los ciudadanos (`user_jid`).
   - En Supabase (nube) **no** se envía el número de teléfono, lo cual es una excelente práctica de privacidad por diseño.
   - Sin embargo, localmente en el servidor, `sessions.db` debe protegerse con `chmod 600` para evitar que otros usuarios del laboratorio puedan extraer la lista de teléfonos de los ciudadanos.
4. **Validación de Entradas del Usuario:**
   - **Ubicación GPS:** Perfectamente validada. Se exige tipo `number` en latitud y longitud.
   - **Afectaciones:** Validadas mediante correspondencia estricta de hash con el arreglo predefinido `AFFECTATION_CATEGORIES`.
   - **Fotografías (Riesgo Potencial):** Se comprueba que exista `rawMsg.imageMessage`, pero no se inspeccionan los *Magic Bytes* del buffer recibido ni se valida un límite estricto de tamaño en bytes antes de almacenarlo en memoria.
5. **Riesgos de Suspensión / Cancelación de Línea de WhatsApp:**
   - Para un análisis exhaustivo del protocolo de conexión (Noise Handshake / Signal Protocol), los motivos por los cuales Meta puede suspender la cuenta y las 6 reglas de oro operativas para proteger el número del bot, consultar la guía técnica: [**`docs/16-seguridad-whatsapp-y-prevencion-de-baneos.md`**](file:///c:/Users/Usuario/Documents/baileys-whatsapp/docs/16-seguridad-whatsapp-y-prevencion-de-baneos.md).

---

### 3.4. Estabilidad y Funcionamiento Continuo (24/7)

1. **Reconexión Automática con WhatsApp:**
   - Implementada en `sock.ev.on('connection.update')`. Si la desconexión no fue provocada por `DisconnectReason.loggedOut`, el bot invoca `setTimeout(connectToWhatsApp, 5000)`.
   - *Mejora recomendada:* Añadir retroceso exponencial con jitter (5s, 15s, 30s, 60s, hasta 5 min) para evitar penalizaciones de WhatsApp en caídas prolongadas de red.
2. **Persistencia y Recuperación ante Caídas:**
   - **Sobresaliente:** Si el servidor se apaga o se reinicia el servicio, la cola `pending_sync_reports` retiene los reportes no sincronizados. Al iniciar, `triggerSyncPendingReports()` procesa automáticamente los reportes pendientes con backoff progresivo.
3. **Limpieza de Archivos Temporales:**
   - Rutina periódica cada 15 minutos (`cleanupExpiredSessionsAndFiles`) y al inicio.
   - Protege activamente las imágenes de sesiones activas (<30 min) y de reportes pendientes de sincronización.
   - Elimina fotografías huérfanas con más de 30 minutos de antigüedad.
4. **Prevención de Múltiples Instancias (Peligro Crítico de Operación):**
   - Actualmente `bot.js` no valida si ya existe otro proceso en ejecución.
   - Si se levanta una segunda instancia mientras corre el servicio de systemd, WhatsApp detecta una doble conexión con las mismas credenciales y cierra ambas en bucle (error 440), desestabilizando completamente el servicio.
   - **Solución Obligatoria:** Agregar comprobación de archivo PID (`bot.lock`).

---

### 3.5. Instalación y Despliegue en el Servidor

1. **Incompatibilidad entre `INSTALACION.md` y Buenas Prácticas de Servidor:**
   - `INSTALACION.md` recomienda utilizar `nohup node bot.js > bot.log 2>&1 &` y `pkill -f "node bot.js"`.
   - En un servidor Linux de laboratorio universitario:
     - `pkill -f "node bot.js"` matará cualquier script de Node que contenga esas palabras, afectando potencialmente a otros usuarios del laboratorio.
     - `nohup` no arranca el bot automáticamente si el servidor se reinicia tras un corte eléctrico.
     - `bot.log` crecerá indefinidamente sin rotación de registros.
2. **Uso del Servicio Systemd ya Diseñado en `docs/13-despliegue-servidor.md`:**
   - El archivo `docs/13-despliegue-servidor.md` ya contiene una unidad systemd de nivel profesional con sandboxing nativo:
     - `NoNewPrivileges=true`
     - `ProtectSystem=full`
     - `ProtectHome=read-only`
     - `ReadWritePaths=/home/floodbot/baileys-whatsapp`
     - `Restart=always` con `RestartSec=5s`
   - La guía `INSTALACION.md` debe actualizarse para adoptar esta configuración como el método estándar.
3. **Procedimiento de Vinculación Inicial:**
   - El código de emparejamiento requiere interacción por consola (`readline` interactivo).
   - Por lo tanto, el primer arranque para vincular el bot **debe ejecutarse interactivamente en la terminal** (`node bot.js`). Una vez confirmado el mensaje `✅ WHATSAPP CONECTADO EXITOSAMENTE`, se cierra con `Ctrl + C` y se delega la ejecución permanente al servicio `systemd`.

---

## 4. Requisitos del Servidor Linux

Para que el profesor pueda desplegar FloodBot sin contratiempos, el servidor del laboratorio debe cumplir con los siguientes requisitos mínimos:

### 4.1. Hardware y Sistema Operativo
- **Sistema Operativo:** Ubuntu Server 22.04 LTS o 24.04 LTS (o Debian 12 "Bookworm").
- **Arquitectura:** x86_64 (amd64) o ARM64.
- **CPU:** Mínimo 1 núcleo (recomendado 2 núcleos).
- **Memoria RAM:** Mínimo 1 GB libre (recomendado 2 GB).
- **Almacenamiento:** Mínimo 5 GB de espacio disponible en disco (para el SO, Node.js, dependencias, logs y archivos temporales de `uploads/`).

### 4.2. Software y Herramientas del Sistema
- **Node.js:** Versión LTS **Node.js 20.x o 22.x** (Estrictamente `>= 20.0.0` exigido por Baileys).
- **npm:** Versión 10.x o superior.
- **Herramientas de Compilación C++:** Paquete `build-essential` y `python3` (imprescindibles para compilar `better-sqlite3` si no hay binario precompilado disponible):
  ```bash
  sudo apt update && sudo apt install -y build-essential python3 curl git
  ```
- **Administrador de Servicios:** `systemd` y `journald`.

### 4.3. Conectividad y Red
- **Tráfico Saliente (Outbound):** Acceso a internet en los siguientes puertos y destinos:
  - Puerto **443 TCP/WSS** hacia `*.whatsapp.net` y `*.whatsapp.com` (Servidores de WhatsApp).
  - Puerto **443 TCP/HTTPS** hacia `*.supabase.co` (API REST y Supabase Storage).
  - Puerto **443 TCP/HTTPS** hacia `registry.npmjs.org` (solo durante la instalación de paquetes).
- **Tráfico Entrante (Inbound):** **Ninguno requerido.** No es necesario abrir puertos en el firewall (`ufw`), ni configurar NAT, DMZ o reenvío de puertos.

---

## 5. Checklist de Verificación Previa a la Entrega al Profesor

Antes de entregar el repositorio al docente, se debe verificar el cumplimiento de los siguientes puntos:

### Seguridad y Credenciales:
- [ ] El archivo `.env` **no** debe estar versionado en el repositorio de Git (`git status` debe confirmar que está ignorado).
- [ ] Proveer una plantilla `.env.example` con las variables requeridas explicadas pero sin contraseñas reales.
- [ ] Verificar que la carpeta `auth_info_baileys/` **no** se suba a Git (contiene las claves criptográficas reales).
- [ ] Aplicar permisos `chmod 700 auth_info_baileys` y `chmod 600 .env sessions.db` en el servidor destino.

### Código y Estabilidad:
- [ ] Implementar el bloqueo de proceso único (`bot.lock`) para prevenir doble instancia accidental.
- [ ] Agregar la purga automática de la tabla `audit_logs` en `cleanupExpiredSessionsAndFiles`.
- [ ] Limitar el tamaño de `global.recentTriggers` y desalojar encuestas viejas de `global.pollRegistry`.
- [ ] Ejecutar `npm test` y certificar que pasen las 14 pruebas automatizadas con 0 fallos.

### Documentación y Despliegue:
- [ ] Unificar `INSTALACION.md` para que la ejecución 24/7 se base en `systemd` (con el unit file endurecido) y no en `nohup`/`pkill`.
- [ ] Verificar si la carpeta `docs/` debe ser des-ignorada en `.gitignore` para que el profesor reciba las 16 guías técnicas y los manuales en PDF.
- [ ] Documentar claramente el procedimiento de vinculación inicial interactivo previo a la activación del servicio `systemd`.

---

## 6. Conclusión y Veredicto Final

### **VEREDICTO: APTO CON CORRECCIONES**

### Justificación:
El proyecto cuenta con una base de código limpia, modular, sin dependencias vulnerables y con un excelente diseño de resiliencia frente a fallos de red y manipulación de archivos (`safeDeleteUploadFile`, cola `pending_sync_reports`, UUIDs compartidos e idempotencia probada).

Sin embargo, **no debe desplegarse en el servidor definitivo de la facultad sin aplicar antes las siguientes 4 correcciones mínimas**:
1. **Control de Recursos:** Agregar la purga de logs en SQLite (`audit_logs`) y la poda de memoria en los Maps globales (`recentTriggers`, `pollRegistry`).
2. **Concurrencia:** Incorporar el bloqueo por archivo PID (`bot.lock`) para evitar colisiones de sesión con WhatsApp.
3. **Instalación:** Sustituir `nohup` y `pkill` en `INSTALACION.md` por el servicio oficial `systemd`.
4. **Seguridad de Archivos:** Configurar permisos estrictos (`chmod 600`/`700`) en el entorno de despliegue.

Una vez aplicadas estas correcciones (las cuales no alteran el flujo conversacional ni las reglas de negocio del bot), FloodBot estará listo para funcionar de manera estable y segura durante meses en el servidor de la facultad.
