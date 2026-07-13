const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(filePath));
    } else if (filePath.endsWith('.ts')) {
      results.push(filePath);
    }
  });
  return results;
}

const srcDir = path.join(__dirname, 'src');
const files = walk(srcDir);

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  // Replace console.log
  if (content.includes('console.log') || content.includes('console.error') || content.includes('console.warn') || content.includes('console.info') || content.includes('console.debug')) {
    
    // figure out relative path to logger
    const depth = file.substring(srcDir.length + 1).split(path.sep).length - 1;
    const relPath = depth === 0 ? './utils/logger' : '../'.repeat(depth) + 'utils/logger';

    if (!content.includes('import { logger }')) {
      content = `import { logger } from '${relPath}';\n` + content;
    }

    content = content.replace(/console\.log/g, 'logger.info');
    content = content.replace(/console\.error/g, 'logger.error');
    content = content.replace(/console\.warn/g, 'logger.warn');
    content = content.replace(/console\.info/g, 'logger.info');
    content = content.replace(/console\.debug/g, 'logger.debug');

    changed = true;
  }

  // Also replace setInterval in index.ts and job files
  if (file.includes('index.ts') && content.includes('startExpirePaymentsJob')) {
    let newContent = content
      .replace(/import \{ start.*\} from '.*';\n/g, '')
      .replace(/start[A-Za-z]+Job\(\);\n/g, '');
    
    if (!newContent.includes('initCronJobs')) {
      newContent = "import { initCronJobs } from './queues/jobQueue';\n" + newContent;
      newContent = newContent.replace('// Start background jobs', 'await initCronJobs();\n    // Start background jobs');
    }
    content = newContent;
    changed = true;
  }

  // remove setInterval and startXXXJob from jobs files
  if (file.includes('jobs\\') || file.includes('jobs/')) {
    if (content.includes('export function start')) {
      // remove the whole function
      content = content.replace(/export function start[A-Za-z]+\s*\([\s\S]*?\}\n/g, '');
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
    console.log(`Updated ${file}`);
  }
});
