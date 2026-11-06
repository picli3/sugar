// Informational description of how Sugar handles data (#25). Every statement must match
// enabled features and providers; owner decisions of 5 November 2026: maintained by Maykol Rey,
// support by email, vulnerabilities through GitHub private reporting, pending legal review.
export type PrivacySection = { id: string; heading: string; paragraphs: string[]; items?: string[] }
export type PrivacyContent = { title: string; status: string; updated: string; back: string; sections: PrivacySection[] }

export const supportEmail = 'maykolrey@gmail.com'
export const vulnerabilityUrl = 'https://github.com/picli3/sugar/security/advisories/new'
export const retention = { draftDays: 7, trashDays: 30, reopenDays: 30, sessionDays: 7, shareLinkDays: 7, recoveryMinutes: 15, registrationMinutes: 30 }

export const privacyContent: Record<'es' | 'en', PrivacyContent> = {
  es: {
    title: 'Privacidad y ayuda',
    status: 'Descripción informativa de cómo funciona Sugar. No son términos ni una política vinculante: está pendiente de revisión legal y puede cambiar.',
    updated: 'Última actualización: 5 de noviembre de 2026',
    back: 'Volver',
    sections: [
      { id: 'who', heading: 'Quién mantiene Sugar y cómo contactar', paragraphs: [
        'Sugar es mantenido por Maykol Rey.',
        `Para ayuda, dudas o solicitudes sobre tus datos escribe a ${supportEmail}.`,
        `Para informar de una vulnerabilidad de seguridad usa el reporte privado de GitHub (${vulnerabilityUrl}); no publiques detalles en issues ni hagas pruebas destructivas contra la instalación pública.`,
      ] },
      { id: 'data', heading: 'Qué datos guarda Sugar', paragraphs: ['Sólo lo necesario para que la aplicación funcione:'], items: [
        'Cuenta: correo, contraseña almacenada sólo como hash, rol, idioma, tema y un nombre público opcional.',
        'Contenido: tus proyectos, bloques, categorías e imágenes, con su historial de revisiones y versiones, y los análisis de IA que solicites.',
        'Seguridad: sesiones con sus fechas de inicio y caducidad, y un registro de operaciones sensibles con el identificador de la cuenta, la operación y su resultado (sin dirección IP ni correo), que se conserva 180 días.',
        'Las imágenes subidas se vuelven a codificar y se eliminan sus metadatos (por ejemplo, ubicación o cámara).',
      ] },
      { id: 'visibility', heading: 'Visibilidad, enlaces e identidad', paragraphs: [], items: [
        'Los proyectos son privados al crearse. Sólo los ven su creador, los colaboradores que invites y los administradores.',
        'Un proyecto público lo puede ver cualquiera que tenga el enlace, sin iniciar sesión.',
        `Los enlaces privados de sólo lectura caducan a los ${retention.shareLinkDays} días y puedes revocarlos en cualquier momento.`,
        'Otras personas te ven por tu nombre público o como «Usuario de Sugar». Tu correo sólo lo ves tú y los administradores; quien gestiona un proyecto ve el correo de los colaboradores que invitó.',
      ] },
      { id: 'ai', heading: 'Análisis con IA', paragraphs: [
        'La IA sólo está disponible si un administrador la activa, y sólo se usa cuando tú pides un análisis o recomendación. El administrador elige un único proveedor entre DeepSeek, OpenAI, Claude (Anthropic), Google Gemini, OpenRouter, Kimi (Moonshot), Z.ai (GLM), Grok (xAI) o MiniMax; tus datos se envían sólo a ese proveedor, se procesan según sus propias condiciones y pueden tratarse fuera de tu país.',
        'Se envía: el nombre del proyecto; de cada bloque, su nombre, función, modelo, propiedades y puertos; las conexiones; y el texto que escribas como enfoque.',
        'No se envía: correos, cuentas, imágenes ni otros proyectos. Se omiten las propiedades cuyo nombre indique credenciales, contraseñas, tokens, imágenes, correos o usuarios, y las URL con credenciales.',
        'El resultado se guarda en el proyecto y lo pueden ver quienes tienen acceso a él. No escribas en tus diagramas información que no quieras compartir con el proveedor.',
      ] },
      { id: 'third', heading: 'Otros servicios externos', paragraphs: [], items: [
        'GitHub: puedes conectar tu cuenta; guardamos sus tokens cifrados en el servidor. Sólo el propietario autoriza el repositorio y la rama de cada proyecto; allí se envían sus revisiones YAML. Desconectar elimina los tokens locales y bloquea nuevos envíos. Los archivos ya publicados en GitHub se conservan.',
        'Correo: el proveedor SMTP configurado por el administrador envía los mensajes de verificación y recuperación de cuenta.',
        'Sugar no usa analítica, publicidad ni rastreadores.',
      ] },
      { id: 'storage', heading: 'Cookies y almacenamiento del navegador', paragraphs: [], items: [
        `Una cookie de sesión (HttpOnly, SameSite=Strict, segura en HTTPS) que caduca a los ${retention.sessionDays} días o al cerrar sesión.`,
        'El navegador recuerda preferencias de interfaz (barra lateral, ancho del panel YAML y del editor); no contienen datos personales.',
        `Los cambios sin guardar de tus proyectos se guardan como borrador sólo en este navegador, separados por cuenta y proyecto, durante ${retention.draftDays} días. Se borran al guardar, al descartarlos, al cerrar sesión o al cerrar tu cuenta; se conservan si la sesión caduca para que puedas recuperarlos.`,
      ] },
      { id: 'retention', heading: 'Conservación y borrado', paragraphs: [], items: [
        `Lo que mueves a la papelera puede restaurarse. Tras ${retention.trashDays} días puedes eliminarlo definitivamente tú o un administrador; nada se borra de forma automática y, mientras tanto, sigue ocupando cuota.`,
        `Al cerrar tu cuenta tus recursos pasan a la papelera y un administrador puede reabrirla durante ${retention.reopenDays} días.`,
        `Los enlaces de recuperación caducan a los ${retention.recoveryMinutes} minutos y los de verificación de registro a los ${retention.registrationMinutes} minutos.`,
        'Antes de cada actualización se guarda una copia de seguridad de la base de datos en el servidor. Esas copias no se eliminan automáticamente, así que los datos borrados pueden permanecer en ellas.',
        'Los registros técnicos rotan automáticamente por tamaño.',
      ] },
      { id: 'rights', heading: 'Tus datos y tus contenidos', paragraphs: [
        'Desde Configuración puedes editar tu perfil, descargar todos tus datos en un ZIP (proyectos y bloques con su historial, imágenes, categorías, análisis y tu registro de operaciones sensibles) y cerrar tu cuenta.',
        `Para cualquier otra solicitud sobre tus datos escribe a ${supportEmail}.`,
        'Eres responsable del contenido que subes y de tener derecho a usarlo. Esta descripción no establece condiciones sobre la propiedad o la licencia de tus contenidos; quedan pendientes de revisión legal.',
      ] },
    ],
  },
  en: {
    title: 'Privacy and help',
    status: 'Informational description of how Sugar works. These are not binding terms or a binding policy: they are pending legal review and may change.',
    updated: 'Last updated: 5 November 2026',
    back: 'Back',
    sections: [
      { id: 'who', heading: 'Who maintains Sugar and how to get in touch', paragraphs: [
        'Sugar is maintained by Maykol Rey.',
        `For help, questions or requests about your data, write to ${supportEmail}.`,
        `To report a security vulnerability, use GitHub private reporting (${vulnerabilityUrl}); do not publish details in issues or run destructive tests against the public installation.`,
      ] },
      { id: 'data', heading: 'What data Sugar keeps', paragraphs: ['Only what the application needs to work:'], items: [
        'Account: email, password stored only as a hash, role, language, theme and an optional public name.',
        'Content: your projects, blocks, categories and images, with their revision and version history, and the AI analyses you request.',
        'Security: sessions with their start and expiry times, and a log of sensitive operations with the account identifier, the operation and its result (no IP address or email), kept for 180 days.',
        'Uploaded images are re-encoded and their metadata (for example location or camera) is removed.',
      ] },
      { id: 'visibility', heading: 'Visibility, links and identity', paragraphs: [], items: [
        'Projects are private when created. Only their creator, the collaborators you invite and administrators can see them.',
        'Anyone with the link can view a public project without signing in.',
        `Private read-only links expire after ${retention.shareLinkDays} days and you can revoke them at any time.`,
        'Other people see you by your public name or as “Sugar user”. Only you and administrators see your email; whoever manages a project sees the email of the collaborators they invited.',
      ] },
      { id: 'ai', heading: 'AI analysis', paragraphs: [
        'AI is only available if an administrator enables it, and it is only used when you request an analysis or recommendation. The administrator chooses a single provider among DeepSeek, OpenAI, Claude (Anthropic), Google Gemini, OpenRouter, Kimi (Moonshot), Z.ai (GLM), Grok (xAI) or MiniMax; your data is sent only to that provider, processed under its own terms and may be handled outside your country.',
        'Sent: the project name; for each block its name, function, model, properties and ports; the connections; and the text you write as the focus.',
        'Not sent: emails, accounts, images or other projects. Properties whose names suggest credentials, passwords, tokens, images, emails or users are omitted, as are URLs with credentials.',
        'The result is stored in the project and can be seen by everyone with access to it. Do not put information in your diagrams that you do not want to share with the provider.',
      ] },
      { id: 'third', heading: 'Other external services', paragraphs: [], items: [
        'GitHub: you can connect your account; its tokens are stored encrypted on the server. Only the project owner authorizes its repository and branch; YAML revisions are sent there. Disconnecting removes local tokens and blocks new synchronization. Files already published on GitHub are retained.',
        'Email: the SMTP provider configured by the administrator sends verification and account recovery messages.',
        'Sugar does not use analytics, advertising or trackers.',
      ] },
      { id: 'storage', heading: 'Cookies and browser storage', paragraphs: [], items: [
        `One session cookie (HttpOnly, SameSite=Strict, secure over HTTPS) that expires after ${retention.sessionDays} days or when you sign out.`,
        'The browser remembers interface preferences (sidebar, YAML panel and editor width); they contain no personal data.',
        `Unsaved project changes are kept as a draft only in this browser, separated by account and project, for ${retention.draftDays} days. They are removed when you save, discard them, sign out or close your account; they are kept if your session expires so you can recover them.`,
      ] },
      { id: 'retention', heading: 'Retention and deletion', paragraphs: [], items: [
        `Anything you move to the trash can be restored. After ${retention.trashDays} days you or an administrator can delete it permanently; nothing is deleted automatically and, meanwhile, it still counts toward your quota.`,
        `When you close your account your resources move to the trash and an administrator can reopen it for ${retention.reopenDays} days.`,
        `Recovery links expire after ${retention.recoveryMinutes} minutes and sign-up verification links after ${retention.registrationMinutes} minutes.`,
        'A database backup is stored on the server before every update. Those backups are not deleted automatically, so deleted data may remain in them.',
        'Technical logs rotate automatically by size.',
      ] },
      { id: 'rights', heading: 'Your data and your content', paragraphs: [
        'From Settings you can edit your profile, download all your data as a ZIP (projects and blocks with their history, images, categories, analyses and your sensitive-operation log) and close your account.',
        `For any other request about your data, write to ${supportEmail}.`,
        'You are responsible for the content you upload and for having the right to use it. This description sets no terms about the ownership or licensing of your content; those are pending legal review.',
      ] },
    ],
  },
}
