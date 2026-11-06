import { sessionRequest } from './sessionRequest.ts'
export type GithubCallbackError = 'denied' | 'invalid' | 'installed' | 'redirectMismatch' | 'suspended' | 'githubError'
export type GithubCallback = { code: string; state: string } | { error: GithubCallbackError; received?: string[] }
export type GithubStatus = { eligible: boolean; configured: boolean; canConnect: boolean; connected: boolean; canDisconnect: boolean; account: { id: string; login: string } | null; needsReauthorization: boolean; installationUrl: string | null }
export type GithubInstallation = { id: string; login: string; writable: boolean }
export type GithubRepository = { id: string; name: string; defaultBranch: string; private: boolean }
export type GithubTarget = { owner: boolean; authorized: boolean; target: { installationId: string; repositoryId: string; repository: string; branch: string; allowPublic: boolean } | null }
export function takeGithubCallback(location: Pick<Location, 'pathname' | 'search' | 'hash'>, history: Pick<History, 'replaceState'>): GithubCallback | null {
  if (location.pathname !== '/oauth/github/callback') return null
  const input = new URLSearchParams(location.search), fragment = location.hash, keys: string[] = []
  input.forEach((_value,key) => keys.push(key))
  history.replaceState(null, '', '/')
  const state = input.get('state'), code = input.get('code')
  // GitHub adds installation_id/setup_action when the App is installed (optionally authorizing
  // during installation). They grant nothing here and are ignored when well formed.
  const installation = input.get('installation_id'), setup = input.get('setup_action')
  const installMarkers = (installation === null || /^[0-9]{1,20}$/.test(installation)) && (setup === null || ['install', 'update', 'request'].includes(setup)) && (installation !== null || setup !== null)
  if (!fragment && !state && installMarkers && keys.every(key => input.getAll(key).length === 1 && ['code','installation_id','setup_action'].includes(key))) return { error: 'installed' }
  // Only parameter names (never values) are kept, so a rejected return can be diagnosed safely.
  const received = [...new Set(keys)].filter(key => /^[a-z_]{1,32}$/.test(key)).slice(0, 8)
  const invalid = { error: 'invalid' as const, received }
  // GitHub reports failures as ?error=<code>&error_description=…&error_uri=…&state=…; only the code is used.
  const failure = input.get('error')
  if (failure !== null && !code && keys.every(key => input.getAll(key).length === 1 && ['error','error_description','error_uri','state'].includes(key))) {
    const known: Record<string, GithubCallbackError> = { access_denied: 'denied', redirect_uri_mismatch: 'redirectMismatch', application_suspended: 'suspended' }
    return { error: known[failure] || 'githubError' }
  }
  if (fragment || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || keys.some(key => input.getAll(key).length !== 1)) return invalid
  const allowed = installMarkers ? ['code','state','installation_id','setup_action'] : ['code','state']
  if (keys.some(key => !allowed.includes(key)) || !code || !/^[A-Za-z0-9_=-]{1,256}$/.test(code)) return invalid
  return { code, state }
}
const copy = {
  es: {
    title: 'Cuenta de GitHub', hint: 'Conecta tu propia cuenta. Cada proyecto requiere que su propietario autorice un repositorio y una rama. Se enviarán las revisiones YAML del proyecto a GitHub.',
    unavailable: 'La conexión con GitHub aún no está habilitada. El administrador debe configurar la App, su URL de retorno y las claves del servidor.',
    disabled: 'Sólo las cuentas con permiso de edición pueden conectar GitHub.', connected: 'Cuenta conectada', connect: 'Conectar con GitHub', reconnect: 'Volver a autorizar', disconnect: 'Desconectar',
    password: 'Contraseña actual de Sugar', passwordWrong: 'La contraseña actual no es correcta.', disconnected: 'Cuenta desconectada. Las sincronizaciones quedan bloqueadas.',
    remotePending: 'El vínculo local se eliminó, pero no se confirmó la revocación remota. Revisa la App autorizada en GitHub.', remoteReplace: 'Cuenta conectada. Revisa y revoca manualmente la autorización anterior en GitHub si ya no la necesitas.',
    renewed: 'GitHub conectado. Vuelve a autorizar el destino en cada proyecto.', reauthorize: 'La autorización caducó, cambió o se interrumpió. Vuelve a conectar tu cuenta y autorizar el destino.',
    install: 'Instalar la App en GitHub', manage: 'Revisar autorizaciones en GitHub', installHint: 'Instala la App sólo en los repositorios que quieras usar. Después actualiza la lista de destinos.',
    denied: 'La autorización fue cancelada en GitHub.', invalid: 'La autorización no es válida o ya fue utilizada. Inicia de nuevo desde Configuración.', redirectMismatch: 'GitHub rechazó la URL de retorno. En la configuración de la GitHub App, «Callback URL» debe ser exactamente {url}.', suspended: 'La App de GitHub está suspendida. El administrador debe reactivarla.', githubError: 'GitHub devolvió un error al autorizar. Revisa la configuración de la App e inténtalo de nuevo.', received: 'Parámetros recibidos', installed: 'La App de GitHub quedó instalada. Ahora pulsa «Conectar con GitHub» para autorizar tu cuenta.', session: 'Necesitas la misma sesión de Sugar que inició la conexión. Inicia sesión y vuelve a empezar desde Configuración.',
    failure: 'No se pudo completar la operación con GitHub. Inténtalo de nuevo.', busy: 'Ya hay una operación en curso o se alcanzó el límite. Espera antes de intentarlo de nuevo.', forbidden: 'Tu cuenta y la App deben tener escritura en ese repositorio. Comprueba también que la instalación esté activa.',
    quota: 'No hay espacio para guardar la autorización. Contacta al administrador.', branchMissing: 'La rama no existe en GitHub. Créala allí o elige una existente.', settingsConflict: 'La configuración cambió. Recarga el proyecto antes de guardar el destino.', conflict: 'Ya existe un archivo distinto para esa revisión. No se sobrescribió.',
    publicRequired: 'El repositorio es público. Confirma expresamente que deseas publicar el proyecto allí.', excessive: 'La cuenta supera el límite de 1.000 instalaciones o repositorios; no se devolvió una lista incompleta.',
    destination: 'Destino en GitHub', ownerOnly: 'Sólo el propietario del proyecto puede conectar y autorizar el destino con su cuenta de GitHub.', settings: 'Conecta o revisa tu cuenta en Configuración → Cuenta de GitHub.',
    authorized: 'Destino autorizado por el propietario', paused: 'Sin autorización vigente: las revisiones no se enviarán hasta autorizar este destino.', load: 'Cargar repositorios disponibles', installation: 'Cuenta u organización', repository: 'Repositorio', branch: 'Rama existente',
    empty: 'No hay repositorios con escritura disponibles para tu cuenta y esta App.', publicLabel: 'público', choose: 'Selecciona un repositorio', save: 'Autorizar y guardar destino', remove: 'Desactivar sincronización', refresh: 'Actualizar', retry: 'Reintentar revisiones pendientes',
    publicConsent: 'Acepto publicar las revisiones YAML de este proyecto en este repositorio público.', saved: 'Destino autorizado y guardado.', confirmDisconnect: 'Desconectar bloqueará las sincronizaciones de tus proyectos hasta que vuelvas a autorizarlos.',
  },
  en: {
    title: 'GitHub account', hint: 'Connect your own account. Each project requires its owner to authorize a repository and branch. Project YAML revisions will be sent to GitHub.',
    unavailable: 'GitHub connections are not enabled yet. The administrator must configure the App, callback URL and server keys.', disabled: 'Only accounts with editing permission can connect GitHub.',
    connected: 'Connected account', connect: 'Connect GitHub', reconnect: 'Authorize again', disconnect: 'Disconnect', password: 'Current Sugar password', passwordWrong: 'The current password is incorrect.', disconnected: 'Account disconnected. Synchronizations are blocked.',
    remotePending: 'The local link was removed, but remote revocation was not confirmed. Review the authorized App on GitHub.', remoteReplace: 'Account connected. Review and manually revoke the previous GitHub authorization if you no longer need it.',
    renewed: 'GitHub connected. Authorize the destination again in each project.', reauthorize: 'Authorization expired, changed or was interrupted. Reconnect your account and authorize the destination.',
    install: 'Install the App on GitHub', manage: 'Review authorizations on GitHub', installHint: 'Install the App only on repositories you want to use. Then refresh the destination list.',
    denied: 'Authorization was cancelled on GitHub.', invalid: 'Authorization is invalid or has already been used. Start again from Settings.', redirectMismatch: 'GitHub rejected the callback URL. In the GitHub App settings, “Callback URL” must be exactly {url}.', suspended: 'The GitHub App is suspended. The administrator must reactivate it.', githubError: 'GitHub returned an error during authorization. Check the App settings and try again.', received: 'Parameters received', installed: 'The GitHub App is installed. Now press “Connect with GitHub” to authorize your account.', session: 'You need the same Sugar session that started the connection. Sign in and start again from Settings.',
    failure: 'The GitHub operation could not be completed. Try again.', busy: 'An operation is already running or a limit was reached. Wait before trying again.', forbidden: 'Your account and the App need write access to that repository. Also check that the installation is active.',
    quota: 'There is no space to save the authorization. Contact the administrator.', branchMissing: 'The branch does not exist on GitHub. Create it there or choose an existing one.', settingsConflict: 'Settings changed. Reload the project before saving the destination.', conflict: 'A different file already exists for this revision. It was not overwritten.',
    publicRequired: 'This repository is public. Explicitly confirm that you want to publish this project there.', excessive: 'The account exceeds the 1,000 installation or repository limit; no partial list was returned.',
    destination: 'GitHub destination', ownerOnly: 'Only the project owner can connect and authorize the destination with their GitHub account.', settings: 'Connect or review your account in Settings → GitHub account.',
    authorized: 'Destination authorized by the owner', paused: 'No current authorization: revisions will not be sent until this destination is authorized.', load: 'Load available repositories', installation: 'Account or organization', repository: 'Repository', branch: 'Existing branch',
    empty: 'No writable repositories are available to your account and this App.', publicLabel: 'public', choose: 'Choose a repository', save: 'Authorize and save destination', remove: 'Disable synchronization', refresh: 'Refresh', retry: 'Retry pending revisions',
    publicConsent: 'I agree to publish YAML revisions of this project to this public repository.', saved: 'Destination authorized and saved.', confirmDisconnect: 'Disconnecting will block project synchronizations until you authorize them again.',
  },
}
export type GithubText = keyof typeof copy.es
export const githubText = (language: 'es' | 'en', key: GithubText) => copy[language][key]
export function githubMessage(code: string, language: 'es' | 'en') {
  let key: GithubText = 'failure'
  if (['GITHUB_CONFIG_REQUIRED','GITHUB_CONNECT_DISABLED','GITHUB_KEY_REQUIRED'].includes(code)) key = 'unavailable'
  else if (['GITHUB_BUSY','GITHUB_REFRESH_IN_PROGRESS','GITHUB_RATE_LIMITED','RATE_LIMITED'].includes(code)) key = 'busy'
  else if (code === 'GITHUB_PASSWORD_INVALID') key = 'passwordWrong'
  else if (code === 'GITHUB_OAUTH_STATE_INVALID' || code === 'GITHUB_INPUT_INVALID') key = 'invalid'
  else if (['GITHUB_ACCESS_DENIED','GITHUB_ACCOUNT_REQUIRED','GITHUB_OWNER_REQUIRED'].includes(code)) key = 'forbidden'
  else if (code === 'GITHUB_BRANCH_MISSING') key = 'branchMissing'
  else if (code === 'GITHUB_REVISION_CONFLICT') key = 'conflict'
  else if (code === 'GITHUB_REPOSITORY_PUBLIC') key = 'publicRequired'
  else if (code === 'GITHUB_CATALOG_TOO_LARGE') key = 'excessive'
  else if (code === 'storageQuotaExceeded') key = 'quota'
  else if (['GITHUB_NOT_CONNECTED','GITHUB_AUTHORIZATION_REQUIRED','GITHUB_USER_REVOKED','GITHUB_AUTH_REJECTED','GITHUB_CONNECTION_CHANGED','GITHUB_SECRET_INVALID','GITHUB_TOKEN_EXPIRED','GITHUB_USER_TOKEN_INVALID','GITHUB_IDENTITY_CHANGED','GITHUB_REFRESH_INTERRUPTED'].includes(code)) key = 'reauthorize'
  return githubText(language, key)
}
export async function githubRequest(path: string, language: 'es' | 'en', body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await sessionRequest('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(response.status === 401 ? githubText(language, 'session') : response.status === 409 && !String(value.code || value.error).startsWith('GITHUB_') && value.code !== 'storageQuotaExceeded' ? githubText(language,'settingsConflict') : githubMessage(response.status === 429 ? 'RATE_LIMITED' : value.code || value.error, language))
  return value
}
