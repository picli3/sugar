import YAML from 'yaml'

export function parseHardwareYaml(text: string) { return YAML.parse(text.replace(/^([ \t]*color:[ \t]*)(#[0-9a-fA-F]{6})(?=[ \t]*(?:#.*)?\r?$)/gm, '$1"$2"')) }
