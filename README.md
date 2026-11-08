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
```bash
# 1. Navegar a la carpeta del proyecto
cd ~/baileys-whatsapp

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
├── package.json                   # Dependencias de producción y scripts
├── package-lock.json              # Registro de versiones fijadas de librerías
├── README.md                      # Este documento
├── sessions.db                    # Base SQLite local para persistencia de reportes en curso
└── supabaseClient.js              # Módulo de integración con Supabase Storage y PostgreSQL
```

---

## 📚 Índice de la Documentación Técnica (`docs/`)

> [!NOTE]
> La carpeta `docs/` (con las 16 guías técnicas detalladas en Markdown y los manuales en PDF) forma parte del material de investigación y tesis académica, manteniéndose en el entorno de desarrollo local y excluida del repositorio público mediante `.gitignore`.

Para profundizar en el diseño, mantenimiento y despliegue del bot en el entorno local, consulta las guías específicas:

* [**00. Panorama General del Sistema**](docs/00-panorama-general.md): Resumen ejecutivo, analogías mecatrónicas y flujo rápido.
* [**01. Introducción al Sistema**](docs/01-introduccion.md): Contexto académico, objetivos de tesis, sensado ciudadano y alcances.
* [**02. Arquitectura de Software y Flujo de Datos**](docs/02-arquitectura-y-flujo.md): Diagramas Mermaid de arquitectura y secuencia de extremo a extremo.
* [**03. Estructura del Código y Árbol de Archivos**](docs/03-estructura-del-codigo.md): Desglose exhaustivo de funciones y líneas reales.
* [**04. Librerías y Tecnologías Utilizadas**](docs/04-librerias-y-tecnologias.md): Matriz pedagógica de 8 preguntas por librería y comparativa con Meta API.
* [**05. Flujo Conversacional y Máquina de Estados**](docs/05-flujo-conversacional.md): Lógica FSM paso a paso, validaciones de GPS/fotos y cancelaciones.
* [**06. Base de Datos Local y Nube (SQLite y Supabase)**](docs/06-base-de-datos-y-supabase.md): Esquema de tablas, las 9 columnas de reporte y subida a Storage.
* [**07. Guía de Instalación y Uso en Windows**](docs/07-instalacion-windows.md): Paso a paso detallado para Windows 10/11 con diagrama de decisión.
* [**08. Guía de Instalación en Servidor Linux**](docs/08-instalacion-linux.md): Instalación con y sin permisos de administrador (NVM), SCP y permisos.
* [**09. Guía de Comandos Rápidos (Cheatsheet)**](docs/09-comandos-rapidos.md): Tablas operativas para Windows CMD y Linux Bash con advertencias.
* [**10. Manual de Modificaciones del Código Fuente**](docs/10-guia-de-modificaciones.md): Matriz Maestra de modificaciones, ejemplos prácticos y rollback con Git.
* [**11. Seguridad, Credenciales y Buenas Prácticas**](docs/11-seguridad-y-credenciales.md): Protección de claves, permisos chmod, RLS y rotación ante incidentes.
* [**12. Batería de Pruebas y Solución de Errores**](docs/12-pruebas-y-solucion-de-errores.md): Protocolo de verificación y árbol de decisión de fallos.
* [**13. Guía de Despliegue Permanente en Linux (Systemd)**](docs/13-despliegue-servidor.md): Configuración de servicios daemon, reinicio automático y `journalctl`.
* [**14. Ejemplo de un Reporte Completo de Extremo a Extremo**](docs/14-ejemplo-reporte-completo.md): Simulación completa con trazabilidad de código y matriz rigurosa de fallos.
* [**15. Guía Explicativa Narrativa para NotebookLM**](docs/15-guia-explicativa-notebooklm.md): Narrativa completa para generación de video explicativo, defensa de tesis y Q&A.