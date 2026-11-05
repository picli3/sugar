# Sugar en producción

GitHub Actions (`.github/workflows/deploy.yml`) ejecuta pruebas unitarias, integración con PostgreSQL y DeepSeek simulado, y la compilación Vue. Solo `main` publica `ghcr.io/picli3/sugar-api:<commit>`,  `ghcr.io/picli3/sugar-web:<commit>` y `ghcr.io/picli3/sugar-database:<commit>`, y despliega ese mismo commit. Los pull requests solo ejecutan pruebas.

La VPS mantiene `/srv/sugar/compose.yaml`, `deploy.sh`, `ssh-gateway.sh`, `.env`, `release.env` y `backups/`. Nginx publica `https://sugar.maykolrey.com` y reenvía a `127.0.0.1:18088`; PostgreSQL y Express no publican puertos. Certbot administra HTTPS. La cookie de sesión lleva `Secure` en producción.

## Configuración inicial

1. Crear el registro DNS A `sugar` apuntando a la VPS.
2. Instalar compose.yaml, deploy.sh, ssh-gateway.sh y security/check-files.py de esta carpeta en `/srv/sugar`, propiedad de root. Crear `.env` con permisos `600`: `DB_PASSWORD`, `RUNTIME_DB_PASSWORD` (64 hex) y `AI_ENCRYPTION_KEY` son obligatorios; `ADMIN_PASSWORD` es necesaria solo al inicializar una base vacía y puede retirarse del arranque después. Conservar esta última clave con las copias de seguridad para recuperar los tokens cifrados. No subir `.env`, claves privadas ni volcados al repositorio.
3. Crear una clave SSH dedicada. En `authorized_keys`, restringirla con `restrict,command="/srv/sugar/ssh-gateway.sh"`. Solo acepta `deploy-v2 <SHA de 40 caracteres>`; no permite terminal, túneles ni comandos arbitrarios. Cambios en los scripts de infraestructura requieren instalación por un administrador.
4. Configurar en GitHub los secretos `VPS_SSH_KEY` y `VPS_KNOWN_HOSTS`, y las variables `VPS_HOST` y `VPS_USER`. La huella SSH se obtiene a través de una conexión administrativa ya verificada.
5. Instalar `nginx.conf`, validar con `nginx -t` y recargar Nginx. Tras propagarse DNS, ejecutar `certbot --nginx -d sugar.maykolrey.com --redirect`.

El token temporal `GITHUB_TOKEN` del trabajo solo se utiliza para descargar las imágenes; Docker usa un directorio de credenciales temporal que se elimina al finalizar. No se guarda un token de GitHub permanente en la VPS.

## Datos y actualizaciones

La primera instalación puede restaurar una copia consistente de la base local antes de iniciar la API. Las actualizaciones posteriores conservan el volumen `sugar_postgres_data` y no vuelven a importar datos locales. Local y producción son instalaciones independientes a partir de esa copia.

Antes de cada actualización se crea un `pg_dump` en `backups/`. El despliegue espera los health checks y solo actualiza `release.env` cuando termina correctamente. Si falla, intenta volver a las imágenes anteriores; los datos no se restauran automáticamente. Las migraciones deben seguir siendo compatibles con la versión anterior para permitir ese rollback. No se borran copias automáticamente: revisar espacio y guardar copias externas periódicamente.

El protocolo `deploy-v2 <SHA>` recibe por entrada estándar el token GHCR y un descriptor v2 validado del artefacto del mismo run. Instalar gateway, runner y Compose juntos antes de liberar: el gateway antiguo rechaza ese comando. Se promueven las tres imágenes analizadas sin reconstruir; el runner verifica sus IDs antes de arrancar y los fija en Compose. `release.env` guarda SHA/IDs atómicamente al terminar. Para repetir una liberación moderna, ejecutar el workflow autorizado y usar su descriptor; no basta con disponer de un tag antiguo o token. El rollback automático conserva los IDs reales anteriores, incluidas versiones sin paquete DB. Ver [imagen, protocolo y reversión](database/README.md).

Los límites de memoria son 512 MiB para PostgreSQL, 384 MiB para la API y 128 MiB para Nginx. Los logs rotan a tres archivos de 10 MiB por servicio. Las imágenes se construyen en GitHub, no en la VPS de 1 vCPU.

### Enlaces privados y registros

Al liberar la protección de imágenes (#5), actualizar la configuración del proxy existente usando `deploy/nginx.conf`, conservando los ajustes HTTPS de Certbot. El formato `sugar_safe` omite query strings y Referer, y oculta los tokens del path `/api/shared/`. Comprobar `nginx -t` antes de recargar. No añadir caché/CDN a imágenes o respuestas compartidas: la API exige `private, no-store`. La reconstrucción de imágenes Docker no reemplaza por sí sola la configuración Nginx del host.

### Cadena de IP y límites de acceso (#7)

Antes de liberar, identificar los proxies que conectan con Express y configurar `TRUSTED_PROXIES` con sus IP/CIDR concretos. La plantilla frontal sobrescribe las cabeceras de IP proporcionadas por el cliente; el web interno añade su salto. Conservar el web en loopback y la API sin puerto público. Validar la cadena efectiva y `nginx -t` durante la liberación autorizada. Sin esta configuración los clientes se agrupan bajo la IP del proxy. Los presupuestos `API_*`/`AUTH_*` están en Compose; ver valores, alcance por proceso y política de reintentos en `api/README.md`. Antes de escalar réplicas se necesita limitación compartida.

### Preparación de acceso administrativo (#9)

El [runbook de seguridad](security/README.md) incluye acceso alternativo, recuperación, rotación, SSH por claves, CI con sudo acotado, permisos y reversión. Su política y el sudoers son plantillas: no se aplican automáticamente ni se cambian accesos actuales. El despliegue nuevo requiere instalar también `security/check-files.py`, proteger su directorio y pasar la auditoría antes de usar Docker. El alta inicial ya no genera/imprime contraseñas; una base vacía requiere ADMIN_PASSWORD explícita. No restablece usuarios existentes. Las comprobaciones del servidor real y cualquier rotación quedan pendientes de una orden de producción.

### Política de red (#10)

Producción usa redes separadas: front para web; application interna para web/API; database interna solo para API/PostgreSQL; egress para las llamadas salientes de API. Solo web publica `127.0.0.1:18088`. El volumen PostgreSQL conserva su nombre. Ver [inventario, matriz de conexiones y reversión](network/README.md) antes de aplicar cambios. El rollback automático de imágenes no restaura una configuración de red previa. No se ha aplicado ni validado esta política en la VPS real.

### Backups cifrados (#11, etapa 1)

El [creador cifrado y ensayo de recuperación](backup/README.md) prepara archivos age mediante un destinatario público y comprueba restauración con datos ficticios. No reemplaza los dumps previos al despliegue ni instala tareas. Transferencia externa, paquete de claves/configuración, retención, alertas y activación siguen pendientes. No se ha respaldado ni restaurado producción con esta herramienta.

### API sin root (#12, etapa 1)

La API usa UID/GID 1000, raíz de solo lectura, tmpfs acotado y restricciones de capacidades/procesos en ambos Compose. Ver [ensayo, compatibilidad de secretos y reversión](containers/README.md). El rol PostgreSQL y las migraciones ya se separan; consultar [configuración y transición](database/README.md) antes de liberar. Esta configuración no se aplicó a producción ni a la instalación local existente.

### Cabeceras y origen (#13)

Ver [clasificación de caché, CSP, protección de escrituras y HTTPS](headers/README.md). Revisar PUBLIC_ORIGIN antes de cambiar el dominio/proxy. El web lleva su snippet en la imagen; la plantilla frontal/HSTS requiere aplicación separada durante una liberación autorizada. No se modificó producción. La inspección de los archivos exportados SVG/PNG permanece pendiente.

### Disponibilidad (#23, etapa 1)

Los healthchecks y verificadores de despliegue usan `/api/ready`, que comprueba DB/esquema con espera limitada y sin diagnósticos sensibles. `/api/health` conserva liveness independiente de DB. Ver [comportamiento, límites y prueba de caída/recuperación](monitoring/README.md). Auditoría de operaciones y alertas externas quedan pendientes; no se activaron monitores o destinos reales.

### Registration/email activation (separate owner decision)

The registration UI and Admin SMTP configuration ship disabled for public signup. Before enabling: complete #2 blockers, run migration, generate/preserve independent `MAIL_ENCRYPTION_KEY` (64 hex characters), configure SMTP as Admin (or SMTP_HOST/PORT/USER/PASSWORD/FROM fallback), and set PUBLIC_ORIGIN. Owner-approved activation requires REGISTRATION_ENABLED=true and an API restart; startup and readiness reject a missing registration migration; startup also rejects incomplete SMTP configuration. Saving SMTP settings alone does not open registration. A later owner-approved release must supply the new key without replacing AI_ENCRYPTION_KEY. Keep both keys in the separately encrypted recovery package. Never use real SMTP for automated tests. See api/README.md for contracts/limits.

### Recovery/email changes

Supply ACCOUNT_RECOVERY_ENABLED=true only for an approved environment after migration and SMTP setup. Signup remains independently gated. Old releases can still read the additive schema with the compatible base marker. Startup rejects a missing recovery capability or malformed SMTP configuration; readiness checks the migration marker without contacting SMTP. Existing addresses are not silently marked verified: account Settings offers password-protected verification/change. Full email changes from a verified address require both inboxes; losing a verified inbox does not justify bypassing this proof. Notification delivery is best effort, with fixed failures and no automatic retries/outbox; #23 tracks operational durability. Production activation remains a separate release decision.

GitHub authorization migration (#22): the release runner stops the previous API before migration and rollback images receive no shared GitHub installation credentials. Keep the release script and Compose updated together. Legacy destinations/jobs remain visible but paused until owner reauthorization; the new connection UI/configuration remains pending.
