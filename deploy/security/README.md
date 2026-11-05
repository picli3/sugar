# Acceso administrativo, secretos y recuperación

Esta es una preparación revisable del issue #9. **No instala políticas ni cambia accesos.** Aplicarla a la VPS, rotar credenciales o revocar claves requiere una nueva orden de producción. No copiar datos privados, claves, salidas de configuración efectiva ni volcados a issues. El inventario de nombres/IP/huellas se guarda fuera del repositorio.

## Condición previa: una salida comprobada

Antes de restringir SSH, el operador debe verificar y registrar de forma privada:

1. Acceso a la consola de recuperación del proveedor con su segundo factor, método de rescate y acceso al disco. Probarla; no basta con conocer el enlace. Confirmar backup recuperable y clave de cifrado. La restauración de datos completa se ensaya en #11.
2. Una cuenta operadora independiente con clave pública propia, passphrase y sudo, fuera del grupo `docker`. Abrir una **segunda conexión nueva**, comprobar `id` y `sudo -v`. Mantener la conexión original abierta. Conservar una segunda clave de emergencia offline y una persona responsable.
3. Copia privada de la configuración SSH principal, snippets, authorized_keys y reglas sudo vigentes, con propietario/permisos originales. Preparar y probar su restauración antes de cambiar nada. No tocar puertos, firewall o usuarios de otras aplicaciones (#10).
4. Plan de reversión desde consola y, si se usa, temporizador local de reversión aprobado. Debe restaurar la copia anterior, validar `sshd -t` y recargar el servicio correcto de la distribución; nunca detener SSH. Cancelarlo solo después de probar conexiones nuevas y el despliegue restringido.

Si alguna condición falta, detener la aplicación de la política y conservar el acceso actual. Esos pasos sobre el servidor real siguen pendientes hasta la liberación autorizada.

## Dos identidades, privilegios distintos

- Operador humano: clave Ed25519 protegida por passphrase, sudo interactivo y acceso de recuperación independiente. Verificar huella del host por un canal ya confiable. No enviar claves privadas ni usar `StrictHostKeyChecking=no`.
- CI: clave exclusiva, sin passphrase interactiva, guardada en GitHub Secrets. En su `authorized_keys`, usar `restrict,command="/srv/sugar/ssh-gateway.sh"` antes de la clave pública; sin entorno, terminal ni forwarding. La huella confiable va en `VPS_KNOWN_HOSTS`. No usar una clave humana o compartir la de otro proyecto.
- El gateway conserva compatibilidad con la clave root restringida existente. Para migrar a `sugar-deploy`, instalar la cuenta sin grupos privilegiados y la regla sudo de esta carpeta: permite únicamente el script root protegido. No conceder sudo general ni acceso al socket Docker. Validar con `visudo -cf`; comprobar `sudo -l -U sugar-deploy`. La cuenta necesita atravesar el directorio para ejecutar el gateway: por ejemplo, root propietario con modo `0711` en `/srv/sugar` y gateway `0755`, conservando `.env`/backups privados. Verificar como esa cuenta el permiso de ejecución; un directorio `0700` de root cortaría el acceso CI no root. El gateway acepta únicamente `deploy-v2 <SHA>`; el runner recibe además el descriptor v2 por stdin descrito en [database/README.md](../database/README.md). Instalar gateway/runner/Compose juntos durante la liberación; un gateway antiguo rechaza el protocolo nuevo. El script exige exactamente un SHA hexadecimal de 40 caracteres y rechaza argumentos extra antes de operar.

## Validación de SSH antes de recargar

`sshd-sugar.conf.example` desactiva contraseña/interactivo, limita intentos y conexiones pendientes y bloquea forwarding/TTY para CI. Usa `PermitRootLogin prohibit-password` para no cortar la clave root forzada durante la transición; eliminar acceso root interactivo es una decisión posterior, tras comprobar operador y CI no root.

Preparar el snippet en una copia de configuración. Validar sintaxis y las opciones **efectivas** para operador y CI con `/usr/sbin/sshd -t -f <copia>` y `/usr/sbin/sshd -T -f <copia> -C user=<cuenta>,host=<host>,addr=<ip>`. OpenSSH usa el primer valor: no asumir que un archivo añadido al final prevalece. Consultar los manuales oficiales de [sshd_config](https://man.openbsd.org/sshd_config) y [sshd](https://man.openbsd.org/sshd.8).

Tras una orden de liberación, instalar solo la configuración revisada, validar otra vez, **recargar** (no reiniciar a ciegas), y probar en nuevas conexiones: ambas claves humanas, sudo, CI con SHA permitido; rechazar contraseña, shell arbitrario, argumentos extra y túneles de CI. Si falla un acceso alternativo, revertir desde la sesión conservada o la consola; no cerrar esa sesión para probar suerte.

## Archivos y secretos

La liberación requiere Docker/Compose, OpenSSH, sudo y Python 3 en el host. Verificar su disponibilidad durante la intervención; el checker nuevo no se instala con la imagen API.

La carpeta de despliegue y scripts deben pertenecer a root y no ser escribibles por grupo/otros. `.env`, claves, credenciales temporales y backups: `0400`/`0600`; directorios privados y `.ssh`: `0700`; authorized_keys: `0600`. La cuenta CI no puede escribir scripts, Compose ni `.env`. Los contenedores no reciben el socket Docker.

`python3 security/check-files.py --root <directorio> --owner-uid 0` audita sin leer valores ni modificar permisos. Puede añadir `--ssh-dir <directorio-ssh> --ssh-owner-uid <uid-real>`. El despliegue lo ejecuta antes de leer el token GHCR o usar Docker. Fallos detienen la operación; corregirlos manualmente tras revisar cada propietario, nunca aplicar chmod/chown recursivo indiscriminado. El checker rechaza symlinks y backups anidados: requieren revisión explícita.

El alta inicial de Sugar exige contraseña proporcionada (12 caracteres, máximo 72 bytes) y no la imprime ni genera una contraseña recuperable en logs. Con cuentas existentes, el bootstrap no crea ni restablece usuarios, aunque se cambie ADMIN_PASSWORD. Tras verificar el acceso, retirar la credencial inicial de las variables/archivos de arranque si ya no es necesaria; retirar también su referencia _FILE antes de quitar el archivo. El servidor admite `DATABASE_URL_FILE`, `ADMIN_PASSWORD_FILE`, `JWT_SECRET_FILE`, `AI_ENCRYPTION_KEY_FILE` y `GITHUB_CLIENT_SECRET_FILE`, `GITHUB_USER_ENCRYPTION_KEY_FILE`: archivo regular, sin symlink, de root/UID del proceso, `0400` o `0600`, máximo 64 KiB. No combinar valor y `_FILE`. Montar solo los archivos necesarios en modo lectura y ajustar el propietario al UID real de la API. El Compose predeterminado sigue utilizando `.env`; pasar a archivos requiere revisar sus variables/mounts, sin valores ficticios que prevalezcan sobre `_FILE`.

Docker y los administradores del host pueden inspeccionar el entorno: permisos de `.env` no sustituyen el control de acceso al daemon. No usar `docker compose config` sin `--quiet`, `docker inspect`, `env`, trazas `set -x` o comandos con secretos en argumentos para producir diagnósticos compartidos. Los errores HTTP/GitHub/arranque registran códigos seguros, sin serializar errores, cabeceras o cuerpos del proveedor. No se borran logs históricos automáticamente: si antes contenían una contraseña, tratarla como expuesta y rotarla durante una intervención autorizada.

## Rotación y recuperación

| Elemento | Procedimiento y reversión |
| --- | --- |
| Clave SSH humana/CI | Añadir la nueva pública junto a la anterior, verificar huella y acceso nuevo/restringido; actualizar CI y probar. Retirar la vieja solo después. Si falla, restaurar authorized_keys de la copia desde consola. Una clave comprometida debe retirarse sin reactivarla como rollback. |
| Contraseña Sugar | Cambiar mediante Configuración con la contraseña actual. Se invalidan todas las sesiones (#6). Recuperación sin contraseña requiere el flujo de #17 o una intervención de consola revisada; no usar variables bootstrap para restablecer una cuenta existente. |
| JWT_SECRET | Respaldar configuración fuera de Git. Preparar secreto aleatorio de al menos 32 bytes en todas las réplicas detenidas. Invalidar sesiones y retirar la clave heredada persistida como se indica abajo, antes de reiniciar y exigir nuevo login. No reactivar una clave comprometida ni dejar que el arranque vuelva a ella. |
| AI_ENCRYPTION_KEY | No sustituir directamente: los tokens guardados están cifrados con ella. Conservar la clave antigua y backup cifrado, deshabilitar IA, reingresar el token con la nueva clave en una intervención autorizada y probar solo si se aprueba el consumo. Ante fallo, restaurar juntos datos cifrados y su clave; nunca mezclar versiones. No hay migración automática de claves. |
| Token DeepSeek | Si se expuso, reemplazarlo y revocarlo también en el proveedor durante la intervención aprobada. Cambiar AI_ENCRYPTION_KEY no anula una API key robada. Mantener IA deshabilitada hasta guardar el nuevo token y aprobar cualquier prueba facturable. |
| Credencial PostgreSQL/GitHub App | Coordinar emisor y consumidores, probar en un clon aislado, actualizar referencias y verificar salud/sincronización. Mantener una vía de reversión cuando el emisor lo permita. No ejecutar ALTER USER ni revocar instalaciones desde esta preparación. |

Para rotar JWT, con backup verificado, todas las réplicas detenidas y la nueva configuración externa preparada, una intervención **autorizada** puede aplicar esta transacción (no ejecutada por esta entrega):

```sql
BEGIN;
UPDATE users SET auth_version=auth_version+1;
UPDATE user_sessions SET revoked_at=now() WHERE revoked_at IS NULL;
DELETE FROM settings WHERE key='jwt_secret';
COMMIT;
```

Así se invalidan las identidades previas y no queda una clave antigua a la que volver si se retira la configuración externa. Reiniciar con la clave nueva, comprobar que tokens anteriores fallan y que un nuevo login funciona; si se revierte una configuración por error operativo, conservar igualmente las identidades antiguas revocadas. Recuperación no significa reabrir sesiones comprometidas.

Durante una recuperación, no abrir registro público, desactivar autenticación ni publicar bases/puertos para entrar. Restaurar acceso por consola, verificar archivos y claves, invalidar sesiones comprometidas y revisar auditoría antes de cerrar la intervención. Backups externos y segundo factor de la aplicación se resuelven en #11/#18.

## Ensayo reproducible

Ejecutar `python3 -m unittest discover -s deploy/security -p 'test_*.py'` para permisos. `docker build -f deploy/security/Dockerfile.test -t sugar-admin-security-test .` y `docker run --rm --network none sugar-admin-security-test` prueban SSH local, dos claves, rechazo de contraseña, CI sin shell/túnel, sudo acotado, rotación y rollback, sin puertos publicados ni acceso al daemon del host. Es una imagen desechable de pruebas; no desplegarla como aplicación. Las pruebas API verifican bootstrap, secretos de archivo y redacción de errores con datos sintéticos. El ensayo no confirma el acceso de emergencia de la VPS real.
