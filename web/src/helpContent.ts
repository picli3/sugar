// Getting-started and editor help (#26). Statements must match the real editor behavior and the
// connection rules enforced by api/src/model.js (same protocol, direction, maxConnections).
type Language = 'es' | 'en'
export type HelpSection = { id: string; heading: string; items: string[]; example?: string }

export const gettingStarted: Record<Language, { title: string; intro: string; steps: string[]; templatesTitle: string; templatesHint: string; create: string }> = {
  es: {
    title: 'Primeros pasos',
    intro: 'Crea tu primer diagrama en unos minutos. Puedes empezar desde una plantilla o desde cero.',
    steps: [
      'Crea un proyecto con «Nuevo proyecto» o desde una plantilla.',
      'Añade bloques desde el panel de bloques con «+» o arrastrándolos a la pizarra.',
      'Conecta un puerto de salida con uno de entrada del mismo protocolo arrastrando entre ellos.',
      'Escribe un resumen y pulsa «Guardar revisión»; el historial conserva cada versión.',
      'Exporta el diagrama en YAML, SVG o PNG, o compártelo desde «Configuración» del proyecto.',
    ],
    templatesTitle: 'Empezar desde una plantilla',
    templatesHint: 'Las plantillas crean un proyecto privado tuyo con bloques de ejemplo; no usan tu biblioteca ni la de otras personas.',
    create: 'Crear',
  },
  en: {
    title: 'Getting started',
    intro: 'Create your first diagram in a few minutes. Start from a template or from scratch.',
    steps: [
      'Create a project with “New project” or from a template.',
      'Add blocks from the blocks panel with “+” or by dragging them onto the board.',
      'Connect an output port to an input port of the same protocol by dragging between them.',
      'Write a summary and press “Save revision”; the history keeps every version.',
      'Export the diagram as YAML, SVG or PNG, or share it from the project “Settings”.',
    ],
    templatesTitle: 'Start from a template',
    templatesHint: 'Templates create a private project of yours with example blocks; they do not use your library or anyone else’s.',
    create: 'Create',
  },
}

export const editorHelp: Record<Language, { title: string; sections: HelpSection[] }> = {
  es: {
    title: 'Ayuda del editor',
    sections: [
      { id: 'blocks', heading: 'Bloques', items: [
        'Añade bloques desde el panel de bloques con «+» o arrastrándolos a la pizarra. Cada bloque guarda una copia de la versión de la biblioteca que usaste.',
        'Selecciona un bloque (clic, o Tab y Enter) para editar sus datos en «Propiedades». Con el teclado puedes moverlo con las flechas.',
      ] },
      { id: 'ports', heading: 'Puertos', items: [
        'Cada puerto tiene un protocolo (por ejemplo POWER, SPI o I2C) y una dirección: entrada (in), salida (out) o bidireccional.',
        'Un puerto puede limitar cuántas conexiones admite (maxConnections).',
      ] },
      { id: 'connections', heading: 'Conexiones', items: [
        'Arrastra desde un puerto de salida o bidireccional hasta uno de entrada o bidireccional.',
        'Los dos puertos deben usar el mismo protocolo; si no, Sugar explica por qué rechaza la conexión.',
        'Selecciona una línea y arrastra sus puntos para cambiar el recorrido. Sin ratón, añade la conexión en el panel YAML.',
      ] },
      { id: 'yaml', heading: 'YAML', items: [
        'El panel YAML muestra el diagrama completo: name, nodes (bloques con su posición) y edges (conexiones). Pulsa «Aplicar YAML» para usar tus cambios.',
      ], example: 'edges:\n  - id: mcu-imu\n    source: mcu\n    sourcePort: spi\n    target: imu\n    targetPort: spi' },
      { id: 'save', heading: 'Guardar y revisiones', items: [
        'Los cambios no se guardan solos: escribe un resumen y pulsa «Guardar revisión».',
        'En «Historial» puedes ver, comparar y restaurar revisiones anteriores.',
      ] },
      { id: 'share', heading: 'Publicar y compartir', items: [
        'Los proyectos nacen privados. En «Configuración» puedes hacerlo público, invitar colaboradores o crear un enlace privado de solo lectura que caduca a los 7 días.',
      ] },
      { id: 'export', heading: 'Exportar e importar', items: [
        'Usa los botones YAML, SVG y PNG de la barra superior para descargar el diagrama.',
        'Desde la lista de proyectos, «Importar YAML» crea un proyecto nuevo a partir de un archivo exportado.',
      ] },
    ],
  },
  en: {
    title: 'Editor help',
    sections: [
      { id: 'blocks', heading: 'Blocks', items: [
        'Add blocks from the blocks panel with “+” or by dragging them onto the board. Each block keeps a copy of the library version you used.',
        'Select a block (click, or Tab and Enter) to edit it under “Properties”. With the keyboard you can move it with the arrow keys.',
      ] },
      { id: 'ports', heading: 'Ports', items: [
        'Each port has a protocol (for example POWER, SPI or I2C) and a direction: input (in), output (out) or bidirectional.',
        'A port can limit how many connections it accepts (maxConnections).',
      ] },
      { id: 'connections', heading: 'Connections', items: [
        'Drag from an output or bidirectional port to an input or bidirectional port.',
        'Both ports must use the same protocol; otherwise Sugar explains why it rejects the connection.',
        'Select a line and drag its handles to change its route. Without a mouse, add the connection in the YAML panel.',
      ] },
      { id: 'yaml', heading: 'YAML', items: [
        'The YAML panel shows the whole diagram: name, nodes (blocks with their position) and edges (connections). Press “Apply YAML” to use your changes.',
      ], example: 'edges:\n  - id: mcu-imu\n    source: mcu\n    sourcePort: spi\n    target: imu\n    targetPort: spi' },
      { id: 'save', heading: 'Saving and revisions', items: [
        'Changes are not saved automatically: write a summary and press “Save revision”.',
        'Under “History” you can view, compare and restore earlier revisions.',
      ] },
      { id: 'share', heading: 'Publishing and sharing', items: [
        'Projects start private. Under “Settings” you can make them public, invite collaborators or create a private read-only link that expires after 7 days.',
      ] },
      { id: 'export', heading: 'Export and import', items: [
        'Use the YAML, SVG and PNG buttons in the top bar to download the diagram.',
        'From the project list, “Import YAML” creates a new project from an exported file.',
      ] },
    ],
  },
}
