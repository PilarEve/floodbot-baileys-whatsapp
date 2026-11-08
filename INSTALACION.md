# Guía de Instalación y Despliegue en Servidor Linux

Esta guía contiene los pasos exactos y secuenciales para clonar, configurar, vincular y ejecutar **FloodBot** en el servidor.

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
Por razones de seguridad y privacidad, las credenciales de Supabase no se suben a GitHub. Debés crearlas manualmente en el servidor:

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

### Paso 4: Diagnóstico de Conexión a Supabase
Antes de encender el bot de WhatsApp, comprobá que el servidor tenga acceso a la base de datos y al bucket de fotos en la nube:

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

### Paso 5: Primer Arranque y Vinculación de WhatsApp
Iniciá el bot por primera vez en primer plano para vincular el número de teléfono:

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

*(Una vez vinculado, la sesión queda guardada de forma permanente en la carpeta `auth_info_baileys/` del servidor; no hace falta volver a vincular).*

---

## 🔄 Ejecución Permanente en Segundo Plano (24/7)

Para que el bot continúe funcionando ininterrumpidamente aunque cierres la terminal o la conexión SSH:

### Iniciar en segundo plano:
```bash
nohup node bot.js > bot.log 2>&1 &
```

### Ver la actividad del bot en tiempo real:
```bash
tail -f bot.log
```
*(Para salir de la visualización en vivo, presioná `Ctrl + C`).*

### Detener el bot:
```bash
pkill -f "node bot.js"
```

### Reiniciar el bot:
```bash
pkill -f "node bot.js" && nohup node bot.js > bot.log 2>&1 &
```

---

## 📁 Estructura Generada en el Servidor Tras la Instalación

```
floodbot-baileys-whatsapp/
├── auth_info_baileys/    # Creado automáticamente tras vincular el número (sesión WhatsApp)
├── node_modules/         # Librerías instaladas por npm
├── uploads/              # Buffer temporal para recepción de fotos
├── .env                  # Credenciales secretas de Supabase (creado en Paso 2)
├── .gitignore            # Reglas de exclusión de Git
├── bot.js                # Orquestador del bot y lógica de estados
├── bot.log               # Registro histórico de actividad (generado por nohup)
├── INSTALACION.md        # Este documento
├── package.json          # Manifiesto de dependencias del bot
├── package-lock.json     # Versiones congeladas de librerías
├── README.md             # Documentación general y arquitectura
├── sessions.db           # Base SQLite local para persistencia de estados
└── supabaseClient.js     # Cliente de integración con Supabase
```

