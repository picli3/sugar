# Roles y migraciones — #12

La API usa `sugar_runtime`, un login PostgreSQL sin superusuario, creación de bases/roles, replicación, bypass RLS, membresías ni propiedad de objetos. Recibe USAGE del esquema, SELECT/INSERT/UPDATE/DELETE de tablas y USAGE/SELECT de secuencias. No recibe CREATE, TEMP, TRUNCATE, permisos de propietario ni grant option. `verifyRuntime` rechaza autoridad administrativa y exige la versión del esquema antes de abrir HTTP o arrancar workers. No hay un modo de fallback privilegiado.

`npm run migrate` / `node src/migrate.js` es el único punto de entrada de inicialización/migración y alta inicial. Conserva las migraciones existentes, con exclusión por conexión PostgreSQL; aplica las concesiones y el marcador de versión en transacción. Establece default privileges del propietario para nuevas tablas/secuencias. Un fallo no marca la versión como completada. Las inicializaciones históricas no son una transacción global: si fallan, revisar el backup y repetir su lógica idempotente; nunca restaurar/borrar datos automáticamente.

El perfil Compose `maintenance` contiene la identidad administrativa existente `designer` para provisionar roles/migrar. No se entrega su contraseña ni ADMIN_PASSWORD a la API normal. Se mantiene el propietario y volumen anteriores; **no se cambia ni degrada automáticamente el superusuario de bootstrap PostgreSQL**. Esa identidad solo debe usarse para mantenimiento; la API rechaza arrancar con ella. El clúster está dedicado a Sugar: el rol reservado es compartido por clúster y no debe reutilizarse para otras aplicaciones. Un rol existente con autoridad inesperada se rechaza, no se demueve a ciegas.

## Preparación y transición autorizada

1. Mantener la instalación actual, respaldo recuperable de DB y claves, Compose/release anteriores y acceso alternativo. No ejecutar este procedimiento en producción sin una orden nueva de liberación.
2. Generar una contraseña nueva mediante `openssl rand -hex 32`, guardándola privadamente como RUNTIME_DB_PASSWORD (64 hex), diferente de DB_PASSWORD. No publicarla ni ponerla en argumentos; .env modo 0600. Se admite RUNTIME_DB_PASSWORD_FILE en el comando de migración con las validaciones existentes de archivos; DATABASE_URL_FILE puede configurar conexiones fuera de Compose, eliminando valores de entorno en conflicto.
3. Instalar también migrate.js y legacy-rollback.yaml junto con las imágenes/configuración probadas. En local: `docker compose up -d --wait db`; `docker compose --profile maintenance run --build --rm migrate`; después `docker compose up --build -d`. Con Node directo: ejecutar npm run migrate con DATABASE_URL administrativa y RUNTIME_DB_PASSWORD; arrancar npm start con una DATABASE_URL distinta del rol restringido, sin contraseña de bootstrap. No pasar la credencial administrativa a la API.
4. El runner de despliegue respalda antes de la migración, levanta/verifica DB, ejecuta el comando maintenance explícitamente y solo entonces levanta la API. Requiere que legacy-rollback.yaml sea un archivo root seguro antes de la primera transición desde una versión antigua. El nuevo release registra DATABASE_ACCESS=runtime-v1. No se ejecutó el runner contra un servidor real durante este trabajo.
5. Verificar salud/login, guardar/restaurar un proyecto, imagen, IA simulada y sincronización, y comprobar SQL con el rol restringido. Conservar las credenciales anteriores para recuperación controlada. Cambiar la contraseña de runtime requiere coordinar migración y todas las réplicas; no se rota por iniciativa del proceso API.

Las concesiones afectan al esquema seleccionado y retiran CREATE/TEMP concedidos a PUBLIC en esa base. No usar esta transición sobre una base compartida con otras aplicaciones. El rol de migración debe ser propietario de los objetos heredados; revisar dueños antes de migrar una instalación personalizada. Los permisos por proyecto/usuario siguen aplicándose en Express: SQL de ejecución tiene DML sobre las tablas de Sugar, no aislamiento RLS por cuenta.

## Reversión

Si falla la migración/arranque, el runner conserva el dump y no importa datos automáticamente. Para una versión previa que ya usa runtime-v1 mantiene la conexión restringida. Para una imagen anterior a esta separación, el override legacy-rollback.yaml devuelve **solo a la imagen anterior** su identidad administrativa original, necesaria para su init-on-start; nunca se usa para ejecutar la API nueva, cuyo guard la rechaza. Los datos y el rol nuevo permanecen. Antes de la siguiente actualización se vuelve al Compose base restringido.

El override restaura esa autoridad de la versión anterior: revisar su necesidad en la liberación y retirarlo del flujo cuando ya no se admita rollback a versiones antiguas. Conservar el archivo/configuración previa y validar permisos; no relajar el guard, hacer DROP OWNED, borrar roles/volúmenes ni cambiar contraseñas a ciegas para resolver un rollback. Ante migraciones futuras incompatibles se necesita una estrategia específica y recuperación del backup con autorización.

## Pruebas

El ensayo de `deploy/containers/smoke.py` usa datos ficticios: crea primero usuarios, proyecto/revisión y bytes de imagen mediante el camino antiguo; migra; compara una huella de los registros heredados; reproduce un arranque legacy y verifica que también conserva la huella. Ese ensayo reproduce el contrato de arranque anterior con código fixture, no usa imágenes ni datos de producción. Comprueba concesiones por defecto creando una tabla desde el propietario y usándola desde runtime. El runtime real rechaza CREATE TABLE/ROLE, SET ROLE designer, DROP/TRUNCATE y tablas temporales. Después pasan login, revisiones, imágenes, DeepSeek simulado, cola GitHub inyectada y persistencia tras reinicio. El override de rollback se renderiza y comprueba por separado.

CI además ejecuta las suites API con servidores runtime y conexiones administrativas reservadas a preparar/limpiar schemas desechables. El test de secretos lanza migración y servidor como procesos separados con archivos privados. El rechazo de flags administrativos/versiones incorrectas y de contraseñas inválidas tiene pruebas unitarias. No se enviaron consultas facturables, correos ni datos reales. PostgreSQL/web mantienen sus entrypoints y necesidades de escritura; esta entrega no pretende convertirlos a raíz de solo lectura.

Fuentes: [GRANT PostgreSQL 17](https://www.postgresql.org/docs/17/sql-grant.html), [default privileges](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html).

## Imagen PostgreSQL corregida — #29

`Dockerfile` es ahora la imagen DB seleccionada por ambos Compose: `sugar-database:local` mediante build local y `ghcr.io/picli3/sugar-database:<commit>` para la próxima liberación autorizada. Conserva PostgreSQL 17.11 y Alpine de la base oficial por digest; reemplaza únicamente gosu e incluye su licencia. La fuente gosu 1.20 está fijada al commit `29b939aa5bd4dc588af765b8248f6e39150d2565` y SHA-256 del archivo. Se reconstruye con Go 1.27.4 por digest y x/sys 0.44.0 exacto; Go verifica los módulos. El binario es estático, sin bits setuid/setgid; conserva el entrypoint, UID/GID y rutas del volumen originales. No se ignoran los avisos del binario anterior ni se cambia el major.

```sh
docker build -t sugar-privilege-database deploy/database
GOSU_TEST_IMAGE=sugar-privilege-database python3 -m unittest discover -s deploy/database -p 'test_gosu.py'
# Construir también los fixtures API/web indicados en deploy/containers:
python3 deploy/containers/smoke.py --rollback-database-image postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
python3 deploy/ci/scan-vulnerabilities.py --images sugar-privilege-api sugar-privilege-web sugar-privilege-database
```

El ensayo usa redes/volumen desechables y datos inventados: original → corregida → original → corregida, conservando el mismo volumen y verificando proyectos/revisiones, imágenes, sesiones, análisis/credenciales sintéticas y sync simulado. Arranca servicios por sus identidades Docker e inspecciona que Compose acepte las identidades verificadas también para maintenance. Prueba inicialización, migración/SQL restringido y persistencia tras parar API y reiniciar DB. Los tests de gosu cubren nombres/números de usuario/grupo, usuario/comando inválido y rechazo de elevar privilegios desde nobody, sin red y con capacidades limitadas.

El escáner de CI analiza las tres imágenes que ahora se construyen y seleccionan; no apunta a una candidata alternativa. El 3 de noviembre, API/web/DB corregida no informaron avisos conocidos, frente a 61 hallazgos (27 HIGH) del gosu oficial anterior. Es el resultado de la base consultada, no una garantía de ausencia de vulnerabilidades. CI conserva el gate estricto y la lista de excepciones vacía.

## Liberación por identidad y compatibilidad

Antes de la primera liberación instalar **juntos**, con autorización nueva, gateway, runner, Compose y override legacy revisados. El protocolo SSH cambia a `deploy-v2 <SHA>`: un gateway antiguo lo rechaza antes de desplegar. Entrada estándar: primera línea token GHCR efímero; segunda línea descriptor compacto v2 del mismo artefacto de Actions, con commit y tres identidades Docker. No escribir tokens en argumentos/logs ni fabricar descriptores a mano. Un workflow antiguo sin descriptor tampoco pasa el runner nuevo.

La publicación exporta y promueve las tres imágenes del gate, sin reconstruir. El runner valida el descriptor, descarga API/web/DB y comprueba sus IDs contra él **antes de cambiar contenedores**. Después fija `API_IMAGE`, `WEB_IMAGE` y `DATABASE_IMAGE` a esos IDs locales; migration y servicios arrancan con esas identidades. Los IDs Docker verifican configuración/contenido de runtime; no se confunden con el digest de un manifiesto OCI comprimido ni sustituyen una firma/atestación. Las imágenes se generan para la arquitectura del runner; otras plataformas requieren build/análisis correspondiente.

El runner conserva los IDs reales de los contenedores anteriores (también detenidos), sin necesitar un paquete DB en una liberación antigua. Ante fallo de arranque, migración o salud, restaura esos IDs locales y la configuración de credenciales previa; funciona incluso al repetir el mismo SHA con tags cambiados. Nunca descarga una supuesta imagen DB antigua construyendo un tag desde el SHA anterior. Si falta un contenedor/imagen necesario o hay una identidad inesperada, se detiene para revisión. No hacer prune de esas imágenes durante una liberación. `release.env` se reemplaza atómicamente, modo 0600, solo después del éxito y registra SHA, modo de acceso y los tres IDs. No restaura ni borra datos automáticamente; la compatibilidad de futuras migraciones sigue requiriendo revisión.

El ensayo `Dockerfile.test-runner` ejecuta el runner root real con Docker/curl ficticios, sin daemon/red/volúmenes del host. Cubre liberación inicial, contenedores detenidos, fallos de pull/identidad por componente, inicio DB/API, migración/salud, rollback legacy/runtime y repetición del SHA, descriptor inválido/incompleto/excesivo y metadatos inalterados al fallar. Esto verifica la orquestación; la conservación real de PostgreSQL se prueba aparte en Compose. La subida/descarga de artefactos de GitHub, push de registro y aplicación real quedan para la liberación autorizada, no se ejecutan en dev.

Fuentes: [gosu oficial](https://github.com/tianon/gosu), [fuente exacta](https://github.com/tianon/gosu/tree/29b939aa5bd4dc588af765b8248f6e39150d2565), [imagen oficial PostgreSQL](https://github.com/docker-library/postgres), [Docker inspect](https://docs.docker.com/reference/cli/docker/image/inspect/), [variables Compose](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

### Compatibilidad de identidad entre almacenes Docker

La primera liberación real detectó una diferencia entre el almacén clásico del runner y containerd en Docker 29 del servidor: `.Id` puede ser el digest de configuración o el del manifiesto. El descriptor conserva el digest de configuración del runtime analizado. Si el ID local difiere, el runner obtiene el RepoDigest inmutable de la imagen descargada y consulta ese manifiesto exacto con autenticación GHCR temporal; exige schema 2 y compara su config.digest con lo esperado. No consulta un tag mutable para decidir la identidad ni omite la comprobación. Índices multiplataforma/salidas ambiguas o fallos se rechazan.

Compose y rollback siguen usando los IDs locales efectivos del motor; release.env registra además API_CONFIG/WEB_CONFIG/DATABASE_CONFIG para conservar las identidades portables. Los fixtures cubren ambos formatos de ID, discrepancia por componente, fallo/formato inesperado del manifiesto y rollback en containerd. La incompatibilidad inicial se detectó antes de cambiar contenedores.
