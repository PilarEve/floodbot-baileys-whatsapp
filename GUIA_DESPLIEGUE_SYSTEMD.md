# Guía Definitiva de Despliegue y Operación con systemd para FloodBot

Esta guía describe el procedimiento paso a paso para desplegar y operar **FloodBot** como un servicio continuo (`systemd`) en el servidor Linux, garantizando disponibilidad 24/7, recuperación automática ante caídas y protección estricta de las sesiones y reportes ciudadanos.

---

## 1. Beneficios Clave del Servicio con systemd

1. **Disponibilidad Continua y Auto-Arranque:** Si el servidor se reinicia por cortes de energía o tareas de mantenimiento, FloodBot arranca automáticamente sin requerir acceso manual por SSH.
2. **Recuperación Automática (`Restart=on-failure`):** Si el proceso Node.js se detiene por un error imprevisto, `systemd` lo reinicia tras 10 segundos.
3. **Protección contra Bucles de Falla:** Mediante `StartLimitIntervalSec=120` y `StartLimitBurst=5` en `[Unit]`, se previene la sobrecarga si ocurriese una falla recurrente de configuración.
4. **Gestión de Instancia de Servicio:** `systemd` asegura que se ejecute una sola instancia del servicio en segundo plano, evitando colisiones en la base de datos `sessions.db` y en WhatsApp.
5. **Apagado Limpio y Seguro (`SIGTERM`):** Al detener o reiniciar el servicio, se liberan los sockets y se confirman las transacciones en SQLite sin borrar datos locales ni reportes pendientes.
6. **Trazabilidad Unificada de Logs:** Salidas y errores se gestionan mediante `journalctl`, evitando archivos de log huérfanos que consuman espacio en disco.

---

## 2. Procedimiento de Despliegue en 8 Pasos

Ejecutar los siguientes comandos en la terminal del servidor con el usuario administrador o con privilegios `sudo`.

### Paso 1: Detener el proceso anterior que corría con `nohup`
Antes de activar el servicio, asegurarse de que no quede ningún proceso previo de Node en ejecución:
```bash
# Localizar procesos activos de bot.js
pgrep -af 'node.*bot.js'

# Si devuelve un número de proceso (PID), detenerlo (ejemplo: kill 12345)
kill <PID>

# Verificar que ya no queden instancias activas
pgrep -af 'node.*bot.js'
```

---

### Paso 2: Actualizar el proyecto desde GitHub
```bash
# Ingresar al directorio del proyecto
cd /home/floodservice/floodbot-baileys-whatsapp

# Descargar las últimas mejoras de estabilidad y configuración
git pull origin main
```

---

### Paso 3: Instalar las dependencias
```bash
# Instalación determinista basada en package-lock.json
npm ci
```

---

### Paso 4: Verificar rutas y permisos de archivos
```bash
# 1. Comprobar la ruta real de Node.js en el sistema
which node
# Si devuelve una ruta diferente a /usr/bin/node (ej: /usr/local/bin/node),
# editar la línea ExecStart en systemd/floodbot.service con esa ruta.

# 2. Asignar la propiedad completa al usuario floodservice
sudo chown -R floodservice:floodservice /home/floodservice/floodbot-baileys-whatsapp

# 3. Permisos de seguridad para credenciales y fotografías
sudo chmod 700 /home/floodservice/floodbot-baileys-whatsapp/auth_info_baileys
sudo chmod 755 /home/floodservice/floodbot-baileys-whatsapp/uploads
sudo chmod 600 /home/floodservice/floodbot-baileys-whatsapp/.env
```

---

### Paso 5: Instalar y habilitar el servicio en systemd
```bash
# Copiar el archivo del servicio al directorio del sistema
sudo cp systemd/floodbot.service /etc/systemd/system/floodbot.service

# (Opcional) Verificar la sintaxis formal del archivo de servicio
systemd-analyze verify /etc/systemd/system/floodbot.service

# Recargar el daemon para registrar el nuevo servicio
sudo systemctl daemon-reload

# Habilitar el servicio para que inicie automáticamente con el sistema
sudo systemctl enable floodbot
```

---

### Paso 6: Iniciar FloodBot
```bash
# Iniciar el servicio
sudo systemctl start floodbot
```

---

### Paso 7: Comprobar el estado y la conexión con WhatsApp
```bash
# 1. Verificar el estado del servicio (debe mostrar 'active (running)' en verde)
sudo systemctl status floodbot

# 2. Seguir la salida del bot en tiempo real (debe mostrar 'WHATSAPP CONECTADO EXITOSAMENTE')
journalctl -u floodbot -f -n 40
```

---

### Paso 8: Consultar errores y reiniciar el servicio cuando sea necesario

| Acción Requerida | Comando a Ejecutar |
|---|---|
| **Ver logs en tiempo real** | `journalctl -u floodbot -f -n 50` |
| **Filtrar solo errores y alertas** | `journalctl -u floodbot -p err -b` |
| **Ver registros de hoy** | `journalctl -u floodbot --since today` |
| **Reiniciar el servicio limpiamente** | `sudo systemctl restart floodbot` |
| **Detener el servicio de forma segura** | `sudo systemctl stop floodbot` |

---

## 3. Procedimiento ante Sesión Desvinculada de WhatsApp (`loggedOut` / 401)

Si WhatsApp desvincula el dispositivo o se revoca el acceso desde la aplicación del teléfono móvil:

1. El bot detecta automáticamente el estado `loggedOut`, preserva las credenciales locales para auditoría y detiene los intentos de reconexión sin saturar el sistema.
2. Para vincular un nuevo número o regenerar el Pairing Code de forma interactiva:

```bash
# 1. Detener el servicio en segundo plano
sudo systemctl stop floodbot

# 2. Entrar a la carpeta del proyecto
cd /home/floodservice/floodbot-baileys-whatsapp

# 3. Ejecutar FloodBot interactivamente con el usuario del servicio
sudo -u floodservice node bot.js
```

3. La terminal solicitará: `👉 Ingresá tu número con código de país (ej: 54911xxxxxxxx):`.
4. Ingresar el número. En pantalla aparecerá el **Código de Vinculación** de 8 caracteres.
5. Abrir WhatsApp en el teléfono > **Dispositivos vinculados** > **Vincular un dispositivo** > **Vincular con el número de teléfono**.
6. Ingresar el código. Cuando la consola confirme `✅ WHATSAPP CONECTADO EXITOSAMENTE`, presionar `Ctrl + C` para salir.
7. Reactivar el servicio en segundo plano:
```bash
sudo systemctl start floodbot
sudo systemctl status floodbot
```

---

## 4. Garantía de Protección de Datos y Persistencia

Durante reinicios, fallos o actualizaciones, el sistema garantiza:
- **`auth_info_baileys/`:** Los tokens y claves de sesión de WhatsApp se preservan en disco y no se eliminan.
- **`sessions.db`:** La base de datos SQLite se cierra de forma segura ante `SIGTERM`, asegurando la integridad transaccional de reportes ciudadanos y sesiones de asesor.
- **`pending_sync_reports`:** Todo reporte confirmado localmente permanecerá en cola hasta sincronizarse exitosamente con Supabase.
- **`uploads/`:** Las imágenes de reportes ciudadanos activos o pendientes jamás son purgadas.
- **Prevención de colisiones:** Antes de ejecutar `node bot.js` manualmente para revincular o probar, detener siempre el servicio con `sudo systemctl stop floodbot`.
