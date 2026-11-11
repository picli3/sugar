# Backups cifrados

Los comandos permiten crear una copia cifrada, verificar la transferencia y ensayar la restauración en PostgreSQL 17 desechable. La programación, retención y activación en producción quedan pendientes.

## Crear un archivo

Requisitos: Linux, Python 3, `age` y un productor confiable como `pg_dump` 17. Generar una identidad con `age-keygen` en un equipo de recuperación seguro. Conservar su archivo privado fuera del servidor, restringido y con una segunda copia recuperable. Exportar solo el destinatario público con `age-keygen -y`. Se admiten varios destinatarios nativos `age1…` para recuperación alternativa. No usar la clave SSH de despliegue para backups.

Ejemplo conceptual, con credenciales PostgreSQL configuradas mediante archivos de servicio/password privados, nunca en argumentos o Git:

```sh
install -d -m 700 /ruta/privada/copias
python3 deploy/backup/create.py \
  --directory /ruta/privada/copias --name copia-UTC-unica.dump.age \
  --recipient age1_DESTINATARIO_PUBLICO \
  --timeout 900 -- pg_dump --no-password -Fc --no-owner --no-acl
```

Sustituir el destinatario de ejemplo por uno válido y definir explícitamente la base origen (`PGSERVICE`, por ejemplo). Si Compose es el productor, usar `docker compose … exec -T db pg_dump …` con proyecto/archivo exactos. El productor es un comando confiable elegido por el operador; el script no evalúa shell.

El script transmite stdout directamente a age, sin dump en claro. Exige carpeta del usuario ejecutor con modo 0700; temporal cifrado y archivo final tienen modo 0600. Solo publica después del éxito de ambos procesos y fsync, sin reemplazar archivos existentes. El timeout cancela ambos grupos de procesos y elimina temporales. Los errores controlados devuelven código distinto de cero y `backup_failed`, sin argumentos ni stderr del productor. Corte eléctrico/SIGKILL puede dejar `.partial-*` cifrados: no son copias válidas. No eliminar temporales activos. No garantiza recuperación ante fallo físico del disco.

La salida incluye tamaño y SHA-256 del **cifrado** para comprobar su futura transferencia. Guardar el registro en un catálogo confiable: un hash junto al archivo no demuestra autoría. age detecta corrupción/truncamiento al descifrar completamente; cualquiera con el destinatario público puede producir otro archivo cifrado. Restaurar solo copias de procedencia confiable.

## Transferir y comprobar

Configurar un destino externo con rclone y guardar su configuración en un archivo del usuario ejecutor con permisos 0600. Usar Python 3.11 o posterior y un destino nombrado con un directorio exclusivo de esta instalación. El destino debe permitir crear y leer objetos. Usar un único escritor por prefijo y conservar los nombres únicos de `create.py`.

```sh
python3 deploy/backup/transfer.py \
  --directory /ruta/privada/copias --name copia-UTC-unica.dump.age \
  --sha256 "$digest_registrado_al_cifrar" \
  --config /ruta/privada/rclone.conf --remote respaldo:sugar/copias
```

El comando compara el archivo local con el hash registrado al cifrar. Luego copia el archivo con rclone, vuelve a leer el objeto completo y compara el SHA-256. Esto consume una subida y una lectura. Solo tras verificar ambos archivos guarda un recibo `<nombre>.verified.json` con modo 0600, nombre, destino, tamaño, hash y fecha UTC. Guardar una copia de los recibos por un canal confiable separado del destino. Usarlos como referencia al descargar y comparar el SHA-256 antes de descifrar.

Si un objeto ya existe, el comando verifica sus bytes y conserva el objeto. Repetir la orden comprueba de nuevo el destino y conserva la fecha del primer recibo. Un fallo devuelve un código distinto de cero y `backup_transfer_failed`, con la copia local disponible para reintentar. Si hay una colisión con bytes distintos, investigar el destino y crear otra copia con un nombre nuevo. El script no elimina objetos. La protección contra cambios por otros escritores depende de la configuración del destino.

Documentación de rclone sobre [copia de archivos](https://rclone.org/commands/rclone_copyto/), [conservación de objetos existentes](https://rclone.org/docs/#ignore-existing) y [verificación mediante descarga](https://rclone.org/commands/rclone_hashsum/).

## Ensayo y recuperación

```sh
docker build -f deploy/backup/Dockerfile.test -t sugar-backup-test .
python3 deploy/backup/smoke.py
```

Usa red interna única sin puertos publicados, bases desechables, identidades efímeras y datos ficticios. Inicializa el esquema real, transfiere el cifrado con rclone a un destino de prueba en un directorio separado y restaura desde ese destino. Compara todas las filas restauradas, la contraseña, el proyecto/revisión, los bytes de adjuntos y el descifrado del token con código real. Prueba corrupción del objeto, reintento, claves erróneas, truncamiento, fallos del productor/cifrador, timeout, permisos y colisiones. Limpia sus contenedores, red y volumen anónimo.

Para una recuperación autorizada, provisionar primero PostgreSQL/roles y una **base nueva vacía y aislada**. Descifrar completamente en almacenamiento temporal privado protegido (preferentemente tmpfs con capacidad calculada); comprobar el éxito de age antes de `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`. No transmitir age directamente a la restauración: la autenticación final puede fallar después de emitir texto. No usar `--clean` contra una base existente. El ensayo pequeño autentica en memoria; no es un restaurador general para bases grandes.

El dump incluye usuarios de la aplicación, hashes, permisos, sesiones, proyectos, revisiones, imágenes bytea y configuración cifrada. No incluye roles globales PostgreSQL ni secretos del entorno. Conservar un paquete **separado y cifrado** con la `AI_ENCRYPTION_KEY` correspondiente, configuración y referencia de release; todavía no se genera automáticamente. Conservar también la `MAIL_ENCRYPTION_KEY` independiente cuando se guarden credenciales SMTP; sin ella no se recupera la contraseña de correo. Conservar también la `MFA_ENCRYPTION_KEY` independiente si se habilita MFA: sin ella se necesitan códigos de recuperación sin usar (no están en el dump) para entrar y desactivar/reconfigurar el factor. El paquete de claves no debe almacenarse junto al dump sin cifrado. Sin la clave de IA no se recuperan los tokens: el ensayo comprueba este fallo. No confundir identidad age y clave de la aplicación. Ver [manejo de secretos](../security/README.md).

Tras restaurar con no-owner/no-acl, ejecutar el comando de mantenimiento con el propietario para provisionar el rol runtime y sus permisos antes de arrancar la API; ver [roles y migraciones](../database/README.md). No iniciar API/workers durante ensayos. Antes de una recuperación real, revisar sesiones/enlaces restaurados, invalidar accesos que ya no correspondan y reconciliar trabajos de sincronización/IA para evitar reenvíos. Son acciones de una liberación autorizada, no del script.

## Pendientes

- Propietario: destino externo, región, coste, credenciales mínimas, RPO (pérdida máxima tolerada), RTO (tiempo máximo de recuperación), frecuencia y retención. No se midieron tiempos reales.
- Próxima etapa: paquete de claves/configuración, programación, retención, alertas de fallo o copia atrasada y restauraciones periódicas. Conservar una copia recuperable antes de aplicar la retención.
- Verificar recuperación por otra persona autorizada y acordar responsables/rotación.
- Los dumps locales previos al despliegue siguen sin cifrado externo ni retención automática. Esta entrega no los sustituye ni satisface por sí sola #11.

Fuentes: [age oficial](https://github.com/FiloSottile/age), [pg_dump 17](https://www.postgresql.org/docs/17/app-pgdump.html), [pg_restore 17](https://www.postgresql.org/docs/17/app-pgrestore.html).
