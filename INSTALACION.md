# Guía de Instalación y Despliegue en Servidor Linux

Esta guía contiene los pasos exactos y secuenciales para clonar, configurar, validar, vincular y ejecutar **FloodBot** en el servidor del laboratorio.

---

## 📋 Requisitos Previos

El servidor debe contar con:
* **Linux** (Ubuntu 20.04/22.04/24.04, Debian 11/12 u otra distribución similar).
* **Git** instalado (`git --version`).
* **Node.js LTS (versión 20.x o 22.x)** y **npm** (`node -v` y `npm -v`).
* **Conexión a Internet** con tráfico saliente habilitado en el puerto 443 (HTTPS/WSS).

> Si el servidor no tiene Node.js instalado, podés instalarlo con:
> ```bash
> curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
> sudo apt install -y nodejs build-essential
> ```

---

## 🚀 Pasos de Instalación

### Paso 1: Clonar el Repositorio
Abrí la terminal del servidor y ejecutá:

```bash
git clone https://github.com/PilarEve/floodbot-baileys-whatsapp.git
cd floodbot-baileys-whatsapp
```

---

### Paso 2: Crear el Archivo de Credenciales (`.env`)
Por razones de seguridad y privacidad, las credenciales de Supabase no se suben al repositorio. Debés crearlas manualmente en el servidor:

1. Creá y abrí el archivo con el editor nano:
   ```bash
   nano .env
   ```

2. Pegá adentro las variables de conexión a Supabase:
   ```env
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_KEY=tu-clave-secreta-supabase-service-role-o-anon
   ```

3. Guardá los cambios y salí del editor:
   * Presioná **`Ctrl + O`** y luego **`Enter`** (para guardar).
   * Presioná **`Ctrl + X`** (para salir).

4. Protegé el archivo para que solo tu usuario pueda leerlo:
   ```bash
   chmod 600 .env
   ```

---

### Paso 3: Instalar Dependencias
Instalá las librerías necesarias del proyecto:

```bash
npm install
```

---

### Paso 4: Ejecutar la Batería de Pruebas Automatizadas
Antes de vincular WhatsApp, verificá que todos los módulos y la base de datos local funcionen al 100% en el servidor ejecutando la suite de 52 pruebas:

```bash
npm test
```

**Salida esperada al finalizar:**
```text
==============================================================================
🎉 BATERÍA COMPLETA: 52 de 52 pruebas aprobadas exitosamente.
🛡️ Aislamiento verificado: sessions.db y uploads/ reales no sufrieron modificaciones.
==============================================================================
```

---

### Paso 5: Diagnóstico de Conexión a Supabase
Comprobá que el servidor tenga acceso a la base de datos PostgreSQL y al bucket de fotos de Supabase en la nube:

```bash
node supabaseClient.js
```

**Salida esperada:**
```text
🔍 Verificando configuración y utilidades de Supabase...
📌 Configuración detectada: { Configurado: 'Sí ✅', ... }
🚀 Probando conectividad remota...
Resultado del test: {
  "success": true,
  "message": "Conexión con Supabase verificada exitosamente (tabla y bucket accesibles)."
}
```

---

### Paso 6: Primer Arranque y Vinculación de WhatsApp
Iniciá el bot por primera vez en primer plano para vincular la línea de WhatsApp:

```bash
node bot.js
```

1. La terminal detectará que no hay sesión activa y mostrará:
   ```text
   ======================================================
   📱 WHATSAPP NO ESTÁ VINCULADO
   ======================================================
   👉 Ingresá tu número con código de país (ej: 59598xxxxxxxx o 54911xxxxxxxx):
   ```
2. Escribí el número de la línea telefónica que usará el bot y presioná **`Enter`**.
3. En 2 o 3 segundos la consola imprimirá un código de emparejamiento de 8 caracteres (por ejemplo: `ABCD-1234`).
4. En el teléfono móvil con esa línea:
   * Abrí **WhatsApp** $\rightarrow$ Menú (tres puntos) o Configuración $\rightarrow$ **Dispositivos vinculados**.
   * Tocá en **Vincular un dispositivo**.
   * Seleccioná la opción inferior: **"Vincular con el número de teléfono"** (o ingresar código).
   * Escribí el código de 8 caracteres.
5. La consola confirmará la conexión:
   ```text
   ✅ WHATSAPP CONECTADO EXITOSAMENTE
   ```

*(Una vez vinculado, la sesión queda guardada de forma permanente en la carpeta `auth_info_baileys/` del servidor; no hace falta volver a vincular tras reiniciar).*

---

## 🔄 Opciones para Ejecución Permanente en Segundo Plano (24/7)

### Opción A: Gestor de Procesos PM2 (Recomendada para Producción)

PM2 mantiene el bot corriendo 24/7 y lo reinicia automáticamente en caso de error o reinicio del servidor:

```bash
# 1. Instalar PM2 globalmente
sudo npm install -g pm2

# 2. Iniciar FloodBot
pm2 start bot.js --name "floodbot"

# 3. Configurar para que arranque automáticamente con el sistema
pm2 save
pm2 startup
```

**Comandos útiles de PM2:**
* Ver logs en tiempo real: `pm2 logs floodbot`
* Ver consumo de CPU y memoria: `pm2 status`
* Reiniciar bot: `pm2 restart floodbot`
* Detener bot: `pm2 stop floodbot`

---

### Opción B: Ejecución Clásica con `nohup` (Sin instalar herramientas extra)

Si preferís no instalar PM2, podés usar `nohup`:

```bash
# Iniciar en segundo plano
nohup node bot.js > bot.log 2>&1 &

# Ver la actividad en tiempo real
tail -f bot.log

# Detener el bot
pkill -f "node bot.js"

# Reiniciar el bot
pkill -f "node bot.js" && nohup node bot.js > bot.log 2>&1 &
```

---

## 📁 Estructura del Repositorio en el Servidor

```
floodbot-baileys-whatsapp/
├── auth_info_baileys/       # Claves criptográficas y sesión activa de WhatsApp (creado al vincular)
├── docs/                    # Centro didáctico de documentación técnica (17 capítulos)
├── node_modules/            # Dependencias del proyecto
├── uploads/                 # Buffer temporal de almacenamiento de imágenes
├── .env                     # Variables de entorno y claves secretas de Supabase
├── .gitignore               # Exclusiones de control de versiones
├── AUDITORIA_PRE_DESPLIEGUE.md # Auditoría de seguridad
├── bot.js                   # Núcleo y máquina de estados FSM del bot
├── DOCUMENTACION_SISTEMA.md # Manual técnico integral del sistema
├── INSTALACION.md           # Este documento de instalación
├── messageQueue.js          # Cola de envíos con espaciado anti-spam y cancelación
├── package.json             # Manifiesto de scripts y dependencias
├── README.md                # Documentación general y arquitectura
├── sessions.db              # Base de datos SQLite local (estados, colas y bitácora)
├── supabaseClient.js        # Integración con Supabase Storage y PostgreSQL
└── test_expiration.js       # Suite de 52 pruebas automatizadas
```
