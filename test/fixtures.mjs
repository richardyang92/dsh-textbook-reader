import { Buffer } from 'node:buffer'
import yazl from 'yazl'

/**
 * Build a synthetic MinerU content_list. The shape follows the documented
 * output: page_idx is 0-based, bbox is normalized 0..1000 and text_level marks
 * headings. This is test data generated in-memory, not a real parse artifact.
 */
export function buildContentList({ pages = 420, chapters = 8, sectionsPerChapter = 4, bookTitle = '示例教材' } = {}) {
  const list = []
  const chapterStarts = []
  const span = Math.max(1, Math.floor(pages / chapters))
  const sectionStep = Math.max(1, Math.floor(span / (sectionsPerChapter + 1)))
  for (let index = 0; index < chapters; index += 1) {
    const page = Math.min(pages, 1 + index * span)
    if (!chapterStarts.includes(page)) chapterStarts.push(page)
  }
  if (chapterStarts[0] !== 1) chapterStarts.unshift(1)

  list.push({
    type: 'text',
    text: bookTitle,
    text_level: 1,
    bbox: [120, 80, 880, 130],
    page_idx: 0,
  })

  for (let page = 1; page <= pages; page += 1) {
    const pageIndex = page - 1
    const chapterIndex = chapterStarts.findIndex((start, index) => {
      const next = chapterStarts[index + 1]
      return page >= start && (next === undefined || page < next)
    })
    if (chapterStarts.includes(page)) {
      list.push({
        type: 'text',
        text: `第${chapterIndex + 1}章 主题 ${chapterIndex + 1}`,
        text_level: 1,
        bbox: [100, 140, 900, 190],
        page_idx: pageIndex,
      })
    }
    for (let section = 0; section < sectionsPerChapter; section += 1) {
      if (page === chapterStarts[chapterIndex] + sectionStep * (section + 1)) {
        list.push({
          type: 'text',
          text: `${chapterIndex + 1}.${section + 1} 小节 ${chapterIndex + 1}.${section + 1}`,
          text_level: 2,
          bbox: [110, 220 + section * 40, 890, 250 + section * 40],
          page_idx: pageIndex,
        })
      }
    }
    list.push({
      type: 'text',
      text: `这是第 ${page} 页的正文内容，用于验证页码定位与 bbox 高亮。`,
      bbox: [100, 300, 900, 760],
      page_idx: pageIndex,
    })
    if (page === 3) {
      list.push({
        type: 'image',
        img_path: 'images/fig1.jpg',
        image_caption: ['图 1：示例插图'],
        bbox: [150, 400, 600, 650],
        page_idx: pageIndex,
      })
    }
    if (page === 5) {
      list.push({
        type: 'table',
        img_path: 'images/table1.jpg',
        table_caption: ['表 1：示例表格'],
        table_body: '<table><tr><td>指标</td><td>数值</td></tr><tr><td>准确率</td><td>92%</td></tr></table>',
        bbox: [120, 420, 880, 640],
        page_idx: pageIndex,
      })
    }
  }
  return list
}

export function buildLayout(pages = 420, { backend = 'vlm', version = '2.6.4' } = {}) {
  const pdf_info = []
  for (let page = 1; page <= pages; page += 1) {
    pdf_info.push({
      page_idx: page - 1,
      page_size: [595, 841],
      preproc_blocks: [],
      para_blocks: [],
    })
  }
  return { _backend: backend, _version_name: version, pdf_info }
}

/** Build a zip buffer without touching the filesystem. */
export function buildZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(String(content)), name)
    }
    zip.end()
    const chunks = []
    zip.outputStream.on('data', (chunk) => chunks.push(chunk))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
  })
}

export async function buildMineruZip({ pages = 30, chapters = 3, sectionsPerChapter = 2, bookTitle = '示例教材' } = {}) {
  const contentList = buildContentList({ pages, chapters, sectionsPerChapter, bookTitle })
  const layout = buildLayout(pages)
  const markdown = contentList
    .filter((item) => item.text_level)
    .map((item) => `${'#'.repeat(item.text_level)} ${item.text}`)
    .join('\n')
  return buildZip({
    'uuid_content_list.json': JSON.stringify(contentList),
    'layout.json': JSON.stringify(layout),
    'full.md': `${markdown}\n`,
    'images/fig1.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    'images/table1.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  })
}
