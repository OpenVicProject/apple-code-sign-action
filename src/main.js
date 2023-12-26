const core = require('@actions/core')
const exec = require('@actions/exec')
const tool_cache = require('@actions/tool-cache')
const glob = require('@actions/glob')
const os = require('os')
const path = require('path')
const promisify = require('util').promisify
const stat = require('fs').stat
const stats = promisify(stat)
const dirname = path.dirname

function getDefaultGlobOptions() {
  return {
    followSymbolicLinks: true,
    implicitDescendants: true,
    omitBrokenSymbolicLinks: true
  }
}

/**
 * If multiple paths are specific, the least common ancestor (LCA) of the search paths is used as
 * the delimiter to control the directory structure for the artifact. This function returns the LCA
 * when given an array of search paths
 *
 * Example 1: The patterns `/foo/` and `/bar/` returns `/`
 *
 * Example 2: The patterns `~/foo/bar/*` and `~/foo/voo/two/*` and `~/foo/mo/` returns `~/foo`
 */
function getMultiPathLCA(searchPaths) {
  if (searchPaths.length < 2) {
    throw new Error('At least two search paths must be provided')
  }

  const commonPaths = []
  const splitPaths = []
  let smallestPathLength = Number.MAX_SAFE_INTEGER

  // split each of the search paths using the platform specific separator
  for (const searchPath of searchPaths) {
    core.debug(`Using search path ${searchPath}`)

    const splitSearchPath = path.normalize(searchPath).split(path.sep)

    // keep track of the smallest path length so that we don't accidentally later go out of bounds
    smallestPathLength = Math.min(smallestPathLength, splitSearchPath.length)
    splitPaths.push(splitSearchPath)
  }

  // on Unix-like file systems, the file separator exists at the beginning of the file path, make sure to preserve it
  if (searchPaths[0].startsWith(path.sep)) {
    commonPaths.push(path.sep)
  }

  let splitIndex = 0
  // function to check if the paths are the same at a specific index
  function isPathTheSame() {
    const compare = splitPaths[0][splitIndex]
    for (let i = 1; i < splitPaths.length; i++) {
      if (compare !== splitPaths[i][splitIndex]) {
        // a non-common index has been reached
        return false
      }
    }
    return true
  }

  // loop over all the search paths until there is a non-common ancestor or we go out of bounds
  while (splitIndex < smallestPathLength) {
    if (!isPathTheSame()) {
      break
    }
    // if all are the same, add to the end result & increment the index
    commonPaths.push(splitPaths[0][splitIndex])
    splitIndex++
  }
  return path.join(...commonPaths)
}

async function findFilesToSign(searchPath, globOptions) {
  const searchResults = []
  const globber = await glob.create(
    searchPath,
    globOptions || getDefaultGlobOptions()
  )
  const rawSearchResults = await globber.glob()

  /*
    Files are saved with case insensitivity. Uploading both a.txt and A.txt will files to be overwritten
    Detect any files that could be overwritten for user awareness
  */
  const set = new Set()

  /*
    Directories will be rejected if attempted to be uploaded. This includes just empty
    directories so filter any directories out from the raw search results
  */
  for (const searchResult of rawSearchResults) {
    const fileStats = await stats(searchResult)
    // isDirectory() returns false for symlinks if using fs.lstat(), make sure to use fs.stat() instead
    if (!fileStats.isDirectory()) {
      core.debug(`File:${searchResult} was found using the provided searchPath`)
      searchResults.push(searchResult)

      // detect any files that would be overwritten because of case insensitivity
      if (set.has(searchResult.toLowerCase())) {
        core.info(
          `Uploads are case insensitive: ${searchResult} was detected that it will be overwritten by another file with the same path`
        )
      } else {
        set.add(searchResult.toLowerCase())
      }
    } else {
      core.debug(
        `Removing ${searchResult} from rawSearchResults because it is a directory`
      )
    }
  }

  // Calculate the root directory for the artifact using the search paths that were utilized
  const searchPaths = globber.getSearchPaths()

  if (searchPaths.length > 1) {
    core.info(
      `Multiple search paths detected. Calculating the least common ancestor of all paths`
    )
    const lcaSearchPath = getMultiPathLCA(searchPaths)
    core.info(
      `The least common ancestor is ${lcaSearchPath}. This will be the root directory of the artifact`
    )

    return {
      filesToSign: searchResults,
      rootDirectory: lcaSearchPath
    }
  }

  /*
    Special case for a single file artifact that is uploaded without a directory or wildcard pattern. The directory structure is
    not preserved and the root directory will be the single files parent directory
  */
  if (searchResults.length === 1 && searchPaths[0] === searchResults[0]) {
    return {
      filesToSign: searchResults,
      rootDirectory: dirname(searchResults[0])
    }
  }

  return {
    filesToSign: searchResults,
    rootDirectory: searchPaths[0]
  }
}

async function getRcodesign(version) {
  const platform = os.platform()
  const arch = os.arch()

  let url =
    'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F'
  url += `${version}/apple-codesign-${version}-`
  let directory = `apple-codesign-${version}-`

  switch (platform) {
    case 'darwin':
      url += 'macos-universal.tar.gz'
      directory += 'macos-universal'
      break

    case 'linux':
      switch (arch) {
        case 'aarch64':
          url += 'aarch64-unknown-linux-musl.tar.gz'
          directory += 'aarch64-unknown-linux-musl'
          break
        case 'x64':
          url += 'x86_64-unknown-linux-musl.tar.gz'
          directory += 'x86_64-unknown-linux-musl'
          break
        default:
          throw new Error(`unsupported Linux architecture: ${arch}`)
      }
      break

    case 'win32':
      if (arch === 'x64') {
        url += 'x86_64-pc-windows-msvc.zip'
        directory += 'x86_64-pc-windows-msvc'
      } else {
        throw new Error(`unsupported Windows architecture: ${arch}`)
      }
      break

    default:
      throw new Error(`unsupported operating system: ${platform}`)
  }

  core.info(`Downloading rcodesign from ${url}`)

  const toolPath = await tool_cache.downloadTool(url)

  let destDir

  if (url.endsWith('.tar.gz')) {
    destDir = await tool_cache.extractTar(toolPath, 'rcodesign')
  } else {
    destDir = await tool_cache.extractZip(toolPath, 'rcodesign')
  }

  let exe = `${destDir}/${directory}/rcodesign`
  if (os.platform === 'win32') {
    exe += '.exe'
  }

  return exe
}

async function run() {
  try {
    const inputPath = core.getInput('input_path', { required: true })
    const sign = core.getBooleanInput('sign')
    const notarize = core.getBooleanInput('notarize')
    const staple = core.getBooleanInput('staple')
    const configFiles = core.getMultilineInput('config_file')
    const profile = core.getInput('profile')
    const pemFiles = core.getMultilineInput('pem_file')
    const p12File = core.getInput('p12_file')
    const p12Password = core.getInput('p12_password')
    const certificateDerFiles = core.getMultilineInput('certificate_der_file')
    const remoteSignPublicKey = core.getMultilineInput('remote_sign_public_key')
    const remoteSignPublicKeyPemFile = core.getInput(
      'remote_sign_public_key_pem_file'
    )
    const remoteSignSharedSecret = core.getInput('remote_sign_shared_secret')
    const appStoreConnectApiKeyJsonFile = core.getInput(
      'app_store_connect_api_key_json_file'
    )
    const appStoreConnectApiIssuer = core.getInput(
      'app_store_connect_api_issuer'
    )
    const appStoreConnectApiKey = core.getInput('app_store_connect_api_key')
    const signArgs = core.getMultilineInput('sign_args')
    const rcodesignVersion = core.getInput('rcodesign_version')

    const rcodesign = await getRcodesign(rcodesignVersion)

    let input_paths = []

    const searchResult = await findFilesToSign(inputPath)
    if (searchResult.filesToSign.length === 0) {
      core.setFailed(
        `No files were found with the provided path: ${inputPath}. No binaries will be signed.`
      )
      return
    } else {
      const s = searchResult.filesToSign.length === 1 ? '' : 's'
      core.info(
        `With the provided path, there will be ${searchResult.filesToSign.length} file${s} signed`
      )
      input_paths = searchResult.filesToSign
    }

    const signed_paths = input_paths.slice()

    if (sign) {
      const args = ['sign']

      for (const conf_path of configFiles) {
        args.push('--config-file', conf_path)
      }

      if (profile) {
        args.push('--profile', profile)
      }

      for (const pem_path of pemFiles) {
        args.push('--pem-file', pem_path)
      }
      if (p12File) {
        args.push('--p12-file', p12File)
      }
      if (p12Password) {
        args.push('--p12-password', p12Password)
      }
      for (const cet_path of certificateDerFiles) {
        args.push('--certificate-der-file', cet_path)
      }
      if (remoteSignPublicKey.length > 0) {
        args.push('--remote-public-key', remoteSignPublicKey.join(''))
      }
      if (remoteSignPublicKeyPemFile) {
        args.push('--remote-public-key-pem-file', remoteSignPublicKeyPemFile)
      }
      if (remoteSignSharedSecret) {
        args.push('--remote-shared-secret', remoteSignSharedSecret)
      }

      for (const arg of signArgs) {
        args.push(arg)
      }

      for (const arg_path of input_paths) {
        const arg_copy = args.slice()
        arg_copy.push(arg_path)

        await exec.exec(rcodesign, arg_copy)
      }
    }

    let stapled = false

    if (notarize) {
      if (!appStoreConnectApiKeyJsonFile) {
        throw new Error(
          'App Store Connect API Key not defined; cannot notarize'
        )
      }

      const args = ['notary-submit']

      for (const conf_path of configFiles) {
        args.push('--config-file', conf_path)
      }

      if (appStoreConnectApiKeyJsonFile) {
        args.push('--api-key-file', appStoreConnectApiKeyJsonFile)
      }
      if (appStoreConnectApiIssuer) {
        args.push('--api-issuer', appStoreConnectApiIssuer)
      }
      if (appStoreConnectApiKey) {
        args.push('--api-key', appStoreConnectApiKey)
      }

      if (staple) {
        args.push('--staple')
      } else {
        args.push('--wait')
      }

      for (const arg_path of signed_paths) {
        const arg_copy = args.slice()
        arg_copy.push(arg_path)

        await exec.exec(rcodesign, arg_copy)
      }

      if (staple) {
        stapled = true
      }
    }

    if (staple && !stapled) {
      const args = ['staple']

      for (const conf_path of configFiles) {
        args.push('--config-file', conf_path)
      }

      for (const arg_path of signed_paths) {
        const arg_copy = args.slice()
        arg_copy.push(arg_path)

        await exec.exec(rcodesign, arg_copy)
      }
    }

    core.setOutput('output_paths', signed_paths)
  } catch (error) {
    core.setFailed(error.message)
  }
}

module.exports = {
  run
}
