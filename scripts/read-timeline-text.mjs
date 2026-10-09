import { parseArgs } from 'node:util';
import { resolve, basename, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { readWorkbenchProjectMetadata } from '../src/project-files.ts';
import { queryTimelineText, formatTimelineText } from '../src/timeline-text.ts';

// Reading a saved snapshot never instantiates Workbench/Runner or loads .env.
try {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, 'timeline-id': { type: 'string' }, 'from-ms': { type: 'string' }, 'to-ms': { type: 'string' },
    search: { type: 'string' }, limit: { type: 'string' }, 'max-characters': { type: 'string' }, cursor: { type: 'string' },
    'include-generated': { type: 'boolean', default: false }, format: { type: 'string', default: 'text' }, help: { type: 'boolean', default: false },
  }, allowPositionals: false });
  if (values.help) {
    process.stdout.write('npm run timeline:text -- --project <project directory or project.json> [--timeline-id ID] [--from-ms N --to-ms N] [--search TEXT] [--limit 5] [--max-characters 8000] [--cursor TOKEN] [--include-generated] [--format text|json]\n');
  } else {
    if (!values.project || !['text', 'json'].includes(values.format)) throw new Error('请指定 --project 项目目录或 project.json，以及有效的 --format text|json');
    const path = resolve(values.project);
    const info = await stat(path);
    if (!info.isDirectory() && (!info.isFile() || basename(path).toLowerCase() !== 'project.json')) throw new Error('请读取项目目录或 project.json');
    const number = key => {
      if (values[key] === undefined) return undefined;
      if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key]))) throw new Error(`${key} 必须为安全非负整数`);
      return Number(values[key]);
    };
    const query = { includeGenerated: values['include-generated'],
      ...(values['timeline-id'] === undefined ? {} : { timelineId: values['timeline-id'] }),
      ...(values.search === undefined ? {} : { search: values.search }), ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      ...Object.fromEntries([['from-ms','fromMs'],['to-ms','toMs'],['limit','limit'],['max-characters','maxCharacters']].flatMap(([flag,key]) => {
        const value = number(flag); return value === undefined ? [] : [[key,value]];
      })),
    };
    const file = await readWorkbenchProjectMetadata(info.isDirectory() ? path : dirname(path));
    const page = queryTimelineText(file.snapshot, query);
    process.stdout.write(values.format === 'json' ? `${JSON.stringify(page)}\n` : formatTimelineText(page));
  }
} catch (error) {
  process.stderr.write(`${error && typeof error === 'object' && 'message' in error ? error.message : '文本时间线读取失败'}\n`);
  process.exitCode = 1;
}
