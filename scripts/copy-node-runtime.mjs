import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// Shared by package builds and executable fixtures. Never change the source image.
export function copyNodeRuntime(destination, source = process.execPath) {
  const platform = process.platform;
  if (!['darwin', 'linux'].includes(platform)) throw Error(`Cannot inspect Node libraries on ${platform}`);
  const run = (command, args) => {
    try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { throw Error(`Node runtime: ${command} ${args.join(' ')} failed: ${error.message}`); }
  };
  const system = path => platform === 'darwin'
    ? path.startsWith('/usr/lib/') || path.startsWith('/System/')
    : /^\/(?:usr\/)?lib(?:64)?\//.test(path);
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const executable = realpathSync(source);
  const images = new Map();
  const names = new Map([[basename(destination), executable]]);
  const libraries = [];
  const systemLibraries = new Set();
  function visit(original, target, inheritedRpaths = []) {
    original = realpathSync(original);
    if (images.has(original)) return;
    images.set(original, target);
    copyFileSync(original, target, constants.COPYFILE_FICLONE);
    let dependencies;
    let rpaths = inheritedRpaths;
    const expand = path => path.replace(/^@loader_path/, dirname(original)).replace(/^@executable_path/, dirname(executable));
    if (platform === 'darwin') {
      const commands = run('otool', ['-l', original]);
      rpaths = [...Array.from(commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset/g), m => expand(m[1])), ...inheritedRpaths];
      const id = run('otool', ['-D', original]).split('\n').slice(1).map(s => s.trim()).filter(Boolean);
      dependencies = run('otool', ['-L', original]).split('\n').slice(1)
        .map(line => line.trim().split(' (compatibility version')[0]).filter(path => path && !id.includes(path))
        .map(name => {
          if (system(name)) return { name, path: name };
          const candidates = name.startsWith('@rpath/') ? rpaths.map(path => join(path, name.slice(7))) : [expand(name)];
          const path = candidates.find(path => isAbsolute(path) && existsSync(path));
          if (!path) throw Error(`Node runtime: cannot resolve library ${name} required by ${original}`);
          return { name, path };
        });
    } else {
      const output = run('ldd', [original]);
      if (/=> not found/.test(output)) throw Error(`Node runtime: unresolved library in ${original}: ${output.trim()}`);
      dependencies = output.split('\n').flatMap(line => {
        const match = line.trim().match(/^(?:(\S+)\s+=>\s+)?(\/.*?)\s+\(0x[\da-f]+\)$/i);
        return match ? [{ name: match[1] || match[2], path: match[2] }] : [];
      });
    }
    const changes = [];
    for (const { name, path } of dependencies) {
      if (system(path)) { systemLibraries.add(path); continue; }
      const actual = realpathSync(path);
      const leaf = basename(path);
      if (names.has(leaf) && names.get(leaf) !== actual) throw Error(`Node runtime: library name collision for ${name}: ${path}`);
      if (!names.has(leaf)) {
        names.set(leaf, actual);
        libraries.push({ source: actual, file: leaf });
        visit(actual, join(directory, leaf), rpaths);
      }
      changes.push([name, leaf]);
    }
    if (changes.length) {
      if (platform === 'darwin') {
        run('install_name_tool', changes.flatMap(([name, leaf]) => ['-change', name, `@loader_path/${leaf}`]).concat(target));
      } else {
        run('patchelf', ['--set-rpath', '$ORIGIN', ...changes.flatMap(([name, leaf]) => ['--replace-needed', name, leaf]), target]);
      }
    }
    // Rewriting load commands invalidates the original Mach-O signature.
    if (platform === 'darwin' && changes.length) run('codesign', ['--force', '--sign', '-', target]);
  }
  visit(executable, resolve(destination));
  // Catch an unusable package before publishing its receipt or manifest.
  run(resolve(destination), ['--version']);
  return { libraries, systemLibraries: [...systemLibraries].sort() };
}
