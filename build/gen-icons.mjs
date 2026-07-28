import sharp from 'sharp'
import { promises as fs } from 'node:fs'
import pngToIco from 'png-to-ico'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILD = __dirname
const svg = await fs.readFile(join(BUILD, 'icon.svg'))

// app 窗口/linux 用:icon-1.png(256)
await sharp(svg, { density: 512 }).resize(256, 256).png().toFile(join(BUILD, 'icon-1.png'))
console.log('icon-1.png 256')

// 托盘小图:icon-2.png(32,托盘会用 resize(16))
await sharp(svg, { density: 512 }).resize(32, 32).png().toFile(join(BUILD, 'icon-2.png'))
console.log('icon-2.png 32')

// ico:多尺寸(16/32/48/64/128/256),Windows 各处自动选
const sizes = [16, 32, 48, 64, 128, 256]
const pngs = await Promise.all(
  sizes.map((s) => sharp(svg, { density: 512 }).resize(s, s).png().toBuffer())
)
const ico = await pngToIco(pngs)
await fs.writeFile(join(BUILD, 'icon.ico'), ico)
console.log('icon.ico', sizes.join('/'))

console.log('done')
