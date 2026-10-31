const fs = require('node:fs');
const path = require('node:path');
    const project = path.resolve(__dirname, '..');
    const target = path.resolve(project, 'web-dist');
    if (path.dirname(target) !== project || path.basename(target) !== 'web-dist') throw new Error('Invalid web output');
    if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.existsSync(path.join(target, '.web-generated')))) throw new Error('Unmanaged web output');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.web-generated'), 'Generated public web assets\n');
    function copyWeb(relative) {
        if (['js/vendor/purchases.js','js/vendor/purchases.LICENSE'].includes(relative.replace(/\\/g, '/'))) return;
        const source = path.join(project, relative);
        const destination = path.join(target, relative);
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Public asset must not be a symlink: ' + relative);
        if (fs.statSync(source).isDirectory()) {
            fs.mkdirSync(destination, { recursive: true });
            for (const name of fs.readdirSync(source)) if (!name.startsWith('.') || relative === '.well-known') copyWeb(path.join(relative, name));
        } else {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(source, destination);
        }
    }
    for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
        const name = entry.name;
        if (entry.isFile() && (/\.html$/.test(name) || ['manifest.json', 'robots.txt', 'sitemap.xml', 'favicon.ico'].includes(name))) copyWeb(name);
        if (entry.isDirectory() && ['js', 'css', 'icons', '.well-known'].includes(name)) copyWeb(name);
    }
    console.log('Public web assets ready: web-dist (API/server source excluded)');
