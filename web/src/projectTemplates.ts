// Starter templates (#26). Self-contained diagrams with block snapshots: they never read the
// library, other projects or the gallery, so they grant no access and expose nothing.
type Language = 'es' | 'en'
type Port = { id: string; label: string; protocol: string; direction: 'in' | 'out' | 'bidirectional'; maxConnections?: number }
type Block = { name: string; function: string; model?: string; ports: Port[] }
export type Diagram = { name: string; nodes: { id: string; position: { x: number; y: number }; block: Block }[]; edges: { id: string; source: string; target: string; sourcePort: string; targetPort: string }[] }
export type TemplateId = 'empty' | 'sensor-node' | 'power-supply'

const text = {
  es: {
    empty: ['Proyecto vacío', 'Empieza desde cero y añade bloques de tu biblioteca.'],
    'sensor-node': ['Nodo de sensores', 'Alimentación USB-C, regulador, microcontrolador y dos sensores por SPI e I2C.'],
    'power-supply': ['Fuente de alimentación', 'Entrada USB-C, cargador de batería y regulador para la lógica.'],
    usb: ['Entrada USB-C', 'Alimentación de 5 V'], ldo: ['Regulador 3,3 V', 'Reduce 5 V a 3,3 V'], mcu: ['Microcontrolador', 'Controla los sensores'],
    imu: ['Sensor IMU', 'Mide aceleración y giro'], temp: ['Sensor de temperatura', 'Mide temperatura'], charger: ['Cargador de batería', 'Carga la batería desde USB'],
    battery: ['Batería Li-ion', 'Almacena energía'], load: ['Lógica 3,3 V', 'Consume la alimentación regulada'],
  },
  en: {
    empty: ['Empty project', 'Start from scratch and add blocks from your library.'],
    'sensor-node': ['Sensor node', 'USB-C power, regulator, microcontroller and two sensors over SPI and I2C.'],
    'power-supply': ['Power supply', 'USB-C input, battery charger and regulator for the logic.'],
    usb: ['USB-C input', '5 V power'], ldo: ['3.3 V regulator', 'Steps 5 V down to 3.3 V'], mcu: ['Microcontroller', 'Controls the sensors'],
    imu: ['IMU sensor', 'Measures acceleration and rotation'], temp: ['Temperature sensor', 'Measures temperature'], charger: ['Battery charger', 'Charges the battery from USB'],
    battery: ['Li-ion battery', 'Stores energy'], load: ['3.3 V logic', 'Uses the regulated supply'],
  },
} as const

export const templateIds: TemplateId[] = ['empty', 'sensor-node', 'power-supply']
export const templateInfo = (id: TemplateId, language: Language) => ({ id, name: text[language][id][0], description: text[language][id][1] })

function block(language: Language, key: keyof typeof text.es, model: string, ports: Port[]): Block {
  const [name, purpose] = text[language][key]
  return { name, function: purpose, model, ports }
}
const edge = (id: string, source: string, sourcePort: string, target: string, targetPort: string) => ({ id, source, target, sourcePort, targetPort })

export function templateDiagram(id: TemplateId, language: Language, name?: string): Diagram {
  const title = name?.trim() || text[language][id][0]
  if (id === 'sensor-node') return {
    name: title,
    nodes: [
      { id: 'usb', position: { x: 0, y: 120 }, block: block(language, 'usb', 'USB-C', [{ id: 'vbus', label: '5V', protocol: 'POWER', direction: 'out' }]) },
      { id: 'ldo', position: { x: 300, y: 120 }, block: block(language, 'ldo', 'AP2112K-3.3', [{ id: 'vin', label: 'VIN', protocol: 'POWER', direction: 'in', maxConnections: 1 }, { id: 'vout', label: '3V3', protocol: 'POWER', direction: 'out' }]) },
      { id: 'mcu', position: { x: 600, y: 120 }, block: block(language, 'mcu', 'RP2040', [{ id: 'pwr', label: '3V3', protocol: 'POWER', direction: 'in', maxConnections: 1 }, { id: 'spi', label: 'SPI0', protocol: 'SPI', direction: 'out' }, { id: 'i2c', label: 'I2C0', protocol: 'I2C', direction: 'bidirectional' }]) },
      { id: 'imu', position: { x: 920, y: 40 }, block: block(language, 'imu', 'BMI270', [{ id: 'spi', label: 'SPI', protocol: 'SPI', direction: 'in', maxConnections: 1 }]) },
      { id: 'temp', position: { x: 920, y: 240 }, block: block(language, 'temp', 'TMP117', [{ id: 'i2c', label: 'I2C', protocol: 'I2C', direction: 'bidirectional' }]) },
    ],
    edges: [edge('usb-ldo', 'usb', 'vbus', 'ldo', 'vin'), edge('ldo-mcu', 'ldo', 'vout', 'mcu', 'pwr'), edge('mcu-imu', 'mcu', 'spi', 'imu', 'spi'), edge('mcu-temp', 'mcu', 'i2c', 'temp', 'i2c')],
  }
  if (id === 'power-supply') return {
    name: title,
    nodes: [
      { id: 'usb', position: { x: 0, y: 120 }, block: block(language, 'usb', 'USB-C', [{ id: 'vbus', label: '5V', protocol: 'POWER', direction: 'out' }]) },
      { id: 'charger', position: { x: 300, y: 120 }, block: block(language, 'charger', 'MCP73831', [{ id: 'vin', label: 'VIN', protocol: 'POWER', direction: 'in', maxConnections: 1 }, { id: 'bat', label: 'BAT', protocol: 'BATTERY', direction: 'bidirectional' }, { id: 'sys', label: 'SYS', protocol: 'POWER', direction: 'out' }]) },
      { id: 'battery', position: { x: 620, y: 20 }, block: block(language, 'battery', '1S 3.7 V', [{ id: 'cell', label: 'BAT+', protocol: 'BATTERY', direction: 'bidirectional', maxConnections: 1 }]) },
      { id: 'ldo', position: { x: 620, y: 220 }, block: block(language, 'ldo', 'AP2112K-3.3', [{ id: 'vin', label: 'VIN', protocol: 'POWER', direction: 'in', maxConnections: 1 }, { id: 'vout', label: '3V3', protocol: 'POWER', direction: 'out' }]) },
      { id: 'load', position: { x: 920, y: 220 }, block: block(language, 'load', '3V3', [{ id: 'pwr', label: '3V3', protocol: 'POWER', direction: 'in' }]) },
    ],
    edges: [edge('usb-charger', 'usb', 'vbus', 'charger', 'vin'), edge('charger-battery', 'charger', 'bat', 'battery', 'cell'), edge('charger-ldo', 'charger', 'sys', 'ldo', 'vin'), edge('ldo-load', 'ldo', 'vout', 'load', 'pwr')],
  }
  return { name: title, nodes: [], edges: [] }
}
