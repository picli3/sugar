# Cabeceras, caché y origen — #13

## Clasificación

| Respuesta | Política |
| --- | --- |
| HTML, rutas SPA y recursos fuera de `/assets/` (excepto el visor incrustado) | `private, no-store`, CSP de interfaz, sin framing |
| JS/CSS compilados con hash en `/assets/`, 200/304 | Caché pública immutable de un año; no contienen datos de cuenta/proyecto |
| Recurso estático inexistente/error | `private, no-store`; conserva cabeceras de seguridad |
| Toda `/api`, incluidos públicos/compartidos, imágenes, YAML, configuración, errores y límites | `private, no-store`, Pragma no-cache, Vary Cookie, no-referrer; sin ETag generado por Express |

Express aplica las cabeceras antes del parser, límites y autenticación. Incluye nosniff, DENY, Permissions-Policy y CSP sin fuentes activas para respuestas API. Nginx web aplica una única política según la ruta y conserva protección también en errores de proxy. Los bloques `add_header` de recursos estáticos incluyen explícitamente el snippet común: no se confía en herencia después de sobrescribir una cabecera.

La CSP de interfaz permite scripts solo del origen propio, sin eval ni scripts inline; bloquea objetos, iframes, framing y cambios de base. CSS inline sigue permitido para Vue Flow, posiciones y colores. Permite Google Fonts en style/font; fuentes data e imágenes data/blob para exportación. Las imágenes externas HTTPS existentes y su inclusión por html-to-image requieren `img-src https:` y `connect-src https:`; este último es una concesión deliberada de compatibilidad, no una lista acotada de destinos. No permite scripts externos. Revisar esas excepciones si se retiran las URLs externas o se alojan fuentes localmente; CSP no sustituye permisos ni sanitización.

## Escrituras y cookies

Las operaciones de escritura comprueban Origin y, si falta, Referer. Fetch Metadata rechaza tanto cross-site como same-site: un subdominio hermano no es un origen confiable. Se rechazan formularios simples/text/plain; los cuerpos deben usar application/json. Una llamada vacía sin Content-Type continúa funcionando, por ejemplo logout. No se habilita CORS. Se mantienen cookies HttpOnly, SameSite=Strict y Secure en producción.

Configurar `PUBLIC_ORIGIN` con esquema, host y puerto exactos, sin path/credenciales. Producción usa por defecto `https://sugar.maykolrey.com`; otros dominios deben cambiarlo. Desarrollo sin valor compara el origen con el Host observado y protocolo de Express. Nginx web conserva el puerto en Host. No se confía en X-Forwarded-Host para decidir el origen. HTTPS detrás de otros proxies requiere PUBLIC_ORIGIN explícito y la cadena TRUSTED_PROXIES revisada según #7.

Clientes de línea de comandos sin Origin/Referer/Fetch Metadata conservan acceso autenticado con JSON. Esta política usa las restricciones del navegador y no exige un token CSRF nuevo; no es autenticación para clientes ajenos ni una protección frente a XSS. No añadir CORS con credenciales/orígenes amplios sin volver a revisar el modelo. Futuras rutas de webhooks deben tener autenticación propia y un alcance explícito.

## HTTPS y activación

La plantilla frontal emite HSTS de un año solo cuando el transporte real de Nginx es HTTPS, sin includeSubDomains/preload. Un X-Forwarded-Proto proporcionado por el cliente no lo activa en HTTP. No se emite HSTS desde el web interno HTTP ni basándose en cabeceras no confiables. Certbot gestiona el certificado/redirección; **esta entrega no modifica la VPS ni sus accesos**.

Durante una liberación autorizada: revisar dominio/proxies, conservar la configuración anterior, aplicar también el snippet y la plantilla frontal preservando los bloques TLS/redirección de Certbot, ejecutar nginx -t y verificar HTTPS/HTTP, cabeceras, sesión, enlaces y exportaciones. No basta con reconstruir imágenes para cambiar Nginx del host. Para revertir, restaurar configuración/imágenes anteriores y validar antes de recargar; no hay cambios de esquema o datos. Eliminar HSTS del servidor no borra la política ya retenida por navegadores: su retirada requiere max-age=0 sobre HTTPS y no es inmediata para clientes desconectados.

## Validación

- API: `cd api && npm test`; pruebas de origen, subdominios, Referer, encabezados falsificados, JSON/formularios, caché y errores antes de acceso a DB.
- Proxy real y aplicación: ensayo `deploy/containers/smoke.py`, con imágenes construidas según su README; verifica clasificación de HTML/assets/API/imágenes/errores y origen permitido/rechazado, además de persistencia y flujos previos.
- Edge: `python3 -m unittest discover -s deploy/headers -p 'test_*.py'`. Usa el template real, certificado sintético efímero y Nginx sin red externa ni puertos publicados. Comprueba HSTS por TLS real y su ausencia en HTTP pese a un encabezado falsificado. La validación del certificado sintético solo se omite dentro del ensayo; no prueba el certificado ni acceso público reales.
- Navegador en instalación ficticia: login, pizarra, imágenes y enlace compartido cargan sin errores CSP observados. SVG/PNG se accionaron sin errores de aplicación observados, pero el controlador no notificó archivos descargados; ocurrió también con YAML de la imagen anterior sin esta CSP. **La inspección final de archivos SVG/PNG sigue pendiente; no se afirma que sus contenidos hayan sido verificados.** No se capturaron pantallas.

Para repetir la comprobación manual, `python3 deploy/containers/smoke.py --preview` abre solo el web ficticio en loopback 8091 hasta pulsar Enter; API/DB mantienen redes internas. Esa modalidad desactiva Secure únicamente para la cookie HTTP ficticia y configura el origen local. El ensayo CI normal no publica puertos y usa la configuración Secure de producción. No usar la modalidad preview con datos reales.

Fuentes: [CSP de MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy), [prevención CSRF de OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Diagramas incrustados — #41

En un proyecto, abre **Configuración → Compartir → Incrustar HTML**. El botón copia el código y lo muestra para copiarlo manualmente si el navegador deniega el portapapeles. Pégalo en un bloque HTML de la publicación. El contenedor ocupa el ancho disponible, con proporción 16:9 y altura mínima de 320 px.

- Los proyectos públicos usan `/embed/public/<uuid>`, con una URL estable. Los privados usan `/embed/shared?token=…`, sujeto a los permisos, caducidad de siete días y revocación del enlace existente. Un código privado da acceso a quien lo posea; para publicaciones permanentes se recomienda un proyecto público.
- El visor permite zoom, desplazamiento, selección y consulta de propiedades. Las propiedades se presentan en tarjetas, con listas y grupos para valores anidados. Los enlaces web se muestran con el nombre de la propiedad (por ejemplo, LCSC o Datasheet) y se abren en otra pestaña; el contenido se presenta como texto seguro. Consulta las revisiones guardadas cada 30 segundos mientras está visible; los cambios sin guardar no se publican. Un fallo temporal conserva el diagrama y ofrece reintento. Si el servidor revoca el acceso, el siguiente intento elimina el diagrama.
- Solo esas rutas reciben `frame-ancestors *` y omiten X-Frame-Options. Montan un componente independiente sin sesión, editor ni administración, y consultan únicamente las API públicas/compartidas con `credentials: omit`. El resto conserva `frame-ancestors 'none'` y `X-Frame-Options: DENY`. Se evalúa `$request_uri` para conservar esta separación tras la redirección interna SPA. La API sigue sin admitir framing. El token privado permanece en la consulta, excluida de los registros HTTP existentes.
- Si la web receptora impone su propia CSP, debe permitir el origen de Sugar en `frame-src`. El editor de publicaciones también debe admitir iframes. No se cambia ninguna política de la web receptora automáticamente.

`web/tests/embed.test.mjs` comprueba las URLs, el escape de atributos HTML y las rutas permitidas. `test_web_embed.py` comprueba la configuración Nginx real, incluidos fallback SPA y rutas manipuladas. Para repetir la prueba de navegador, construye las imágenes indicadas en `deploy/containers/README.md` y ejecuta `python3 deploy/containers/smoke.py --preview`. Con Playwright y Chromium instalados en el entorno de pruebas, en otra terminal ejecuta

```sh
EMBED_TEST_URL=http://localhost:8091 node web/test-support/embed-browser.cjs
```

Se pueden indicar `PLAYWRIGHT_MODULE` y `CHROME_EXECUTABLE` si están instalados en otra ubicación. El script solo admite ese destino desechable, crea datos sintéticos y una página receptora en otro origen local. Verifica generación del código, interacción sin escrituras, imágenes e iconos, colores, móvil/escritorio, español/inglés, actualización automática, fallos temporales y revocación. Cierra el preview con Enter para eliminar sus contenedores y volúmenes.
