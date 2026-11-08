# FloodBot — Bot de WhatsApp para Monitoreo Ciudadano de Inundaciones

**FloodBot** es un agente conversacional autónomo desarrollado en **Node.js** con la librería **Baileys** para la captura, estructuración y persistencia en la nube (**Supabase**) de reportes ciudadanos de inundaciones y anegamientos urbanos.

Este desarrollo forma parte de un proyecto de tesis de grado en **Ingeniería Mecatrónica** orientado a la gestión de emergencias y alerta temprana ante fenómenos hidrometeorológicos severos.

---

## 🚀 Estado Operativo y Funcionalidades Validadas

* 🟢 **Conexión Directa y Cifrada**: Comunicación WebSocket segura (WSS, puerto 443) con los servidores oficiales de WhatsApp. Sin servidores web ni puertos de red locales abiertos en el equipo anfitrión.
* 🟢 **Máquina de Estados Conversacional (FSM)**:
  1. *Captura Satelital*: Recepción y validación obligatoria de coordenadas GPS (`locationMessage` / `liveLocationMessage`).
  2. *Evidencia Visual*: Descarga binaria y almacenamiento seguro de fotografías de incidentes en `uploads/`.
  3. *Tipificación Interactiva*: Envío de encuesta nativa de WhatsApp con 11 afectaciones urbanas estandarizadas y captura de descripción cualitativa.
  4. *Confirmación Explícita*: Presentación de resumen estructurado y confirmación de envío.
* 🟢 **Persistencia Híbrida Cloud (Supabase)**:
  - Subida automática de imágenes a Supabase Storage (bucket `reportes`, subcarpeta `whatsapp/`).
  - Inserción relacional de los reportes en la tabla `public.reportes_whatsapp` de PostgreSQL.
  - Eliminación automática de fotos locales temporales tras confirmar el éxito de ambas operaciones en la nube.
* 🟢 **Vinculación por Terminal (CMD / Bash)**: Emparejamiento por código de 8 dígitos (Pairing Code) sin necesidad de interfaz web ni escaneo de código QR. Reconexión instantánea permanente mediante `auth_info_baileys/`.

---

## 🛠️ Requisitos del Sistema

* **Sistema Operativo**: Windows 10/11 o Linux (Ubuntu, Debian, Fedora, Arch, Raspberry Pi OS).
* **Node.js**: Versión LTS 20.x o 22.x.
* **npm**: Incluido con Node.js.
* **Red**: Conexión a internet con tráfico saliente habilitado en el puerto 443 (HTTPS/WSS).
* **Teléfono móvil**: Con línea activa y WhatsApp instalado para la vinculación del bot.

---

## ⚡ Inicio Rápido

### En Windows (CMD o PowerShell)
```cmd
# 1. Navegar a la carpeta del proyecto
cd /d C:\Users\Usuario\Documents\baileys-whatsapp

# 2. Instalar dependencias (solo la primera vez)
npm install

# 3. Comprobar conexión con Supabase
node supabaseClient.js

# 4. Iniciar el bot
node bot.js
```
*(Para detener el bot en cualquier momento: presionar `Ctrl + C`)*

### En Servidor Linux (Laboratorio)

> 📖 Para la guía detallada paso a paso desde el clonado hasta el despliegue permanente (24/7), consultá [**INSTALACION.md**](INSTALACION.md).

```bash
# 1. Navegar a la carpeta del proyecto
cd ~/floodbot-baileys-whatsapp

# 2. Instalar dependencias exactas
npm ci --omit=dev

# 3. Comprobar conexión con Supabase
node supabaseClient.js

# 4. Iniciar el bot en primer plano
node bot.js
```

---

## 📁 Estructura del Repositorio

```
baileys-whatsapp/
├── auth_info_baileys/             # Claves criptográficas y sesión activa de WhatsApp (ignorado en Git)
├── docs/                          # Centro de documentación técnica completa (16 guías)
│   ├── README.md                  # Índice temático y 5 rutas de aprendizaje
│   ├── manual-tecnico-floodbot.pdf           # PDF 1: Manual técnico consolidado
│   └── floodbot-paso-a-paso-notebooklm.pdf  # PDF 2: Guía didáctica para NotebookLM
├── uploads/                       # Carpeta temporal limpia para recepción de fotos (ignorado en Git)
├── .env                           # Credenciales secretas de Supabase (ignorado en Git)
├── .gitignore                     # Reglas estrictas de exclusión para control de versiones
├── bot.js                         # Código fuente central del bot (~600 líneas)
├── INSTALACION.md                 # Guía paso a paso de instalación y despliegue en Linux
├── package.json                   # Dependencias de producción y scripts
├── package-lock.json              # Registro de versiones fijadas de librerías
├── README.md                      # Este documento
├── sessions.db                    # Base SQLite local para persistencia de reportes en curso
└── supabaseClient.js              # Módulo de integración con Supabase Storage y PostgreSQL
```

