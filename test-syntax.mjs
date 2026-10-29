import fs from 'fs';
const html = fs.readFileSync('src/dashboard.ts', 'utf8');
const match = html.match(/export const managerDashboardHtml = `([\s\S]*?)`/);
if (match) {
  const script = match[1].match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (script) {
    try {
      new Function(script);
      console.log('OK');
    } catch(e) {
      console.log('ERROR:', e.message);
      // Try removing IIFE wrapper
      const inner = script.replace(/^\(\)=>\{/, '').replace(/\}\)\(\);?\s*$/, '');
      try {
        new Function(inner);
        console.log('OK without IIFE wrapper');
      } catch(e2) {
        console.log('ERROR without IIFE:', e2.message);
        // Find the line
        const lines = inner.split('\n');
        for (let i = 0; i < lines.length; i++) {
          try {
            new Function(lines.slice(0, i+1).join('\n'));
          } catch(e3) {
            console.log('Fails at line', i+1, ':', e3.message);
            console.log('  content:', lines[i].substring(0, 100));
            break;
          }
        }
      }
    }
  }
}
