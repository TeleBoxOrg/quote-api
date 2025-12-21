const ffmpeg = require('fluent-ffmpeg')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

function isAnimatedMedia (buffer) {
  if (!buffer || buffer.length < 12) return { type: 'unknown', animated: false }

  // 检测 GIF (0x47 0x49 0x46 = 'GIF')
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { type: 'gif', animated: true }
  }

  // 检测 WebM 视频贴纸 (0x1A 0x45 0xDF 0xA3 = EBML header)
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return { type: 'webm', animated: true }
  }

  // 检测动态 WebP (RIFF + WEBP + ANIM 块)
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    for (let i = 12; i < buffer.length - 4; i++) {
      if (buffer.toString('ascii', i, i + 4) === 'ANIM') {
        return { type: 'webp', animated: true }
      }
    }
  }

  return { type: 'unknown', animated: false }
}

// 从 webm/gif 中提取第一帧作为 PNG
async function extractFirstFrame (buffer, format = 'webm') {
  const tmpDir = os.tmpdir()
  const uniqueId = crypto.randomBytes(8).toString('hex')

  const inputPath = path.join(tmpDir, `input_${uniqueId}.${format}`)
  const outputPath = path.join(tmpDir, `frame_${uniqueId}.png`)

  try {
    fs.writeFileSync(inputPath, buffer)

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-vframes', '1', '-f', 'image2'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    const frameBuffer = fs.readFileSync(outputPath)
    return frameBuffer
  } finally {
    try { fs.unlinkSync(inputPath) } catch (e) {}
    try { fs.unlinkSync(outputPath) } catch (e) {}
  }
}

async function overlayAnimatedMedia (backgroundBuffer, animatedBuffer, mediaInfo, outputFormat = 'webp', inputFormat = 'webp', messageBoxColor = null) {
  const tmpDir = os.tmpdir()
  const uniqueId = crypto.randomBytes(8).toString('hex')

  const bgPath = path.join(tmpDir, `bg_${uniqueId}.png`)
  const animPath = path.join(tmpDir, `anim_${uniqueId}.${inputFormat}`)
  // 对于动态输出，始终使用 webm 格式（Telegram 贴纸需要）
  const actualOutputFormat = (inputFormat === 'webm' || inputFormat === 'gif') ? 'webm' : outputFormat
  const outputPath = path.join(tmpDir, `output_${uniqueId}.${actualOutputFormat}`)

  console.log(`FFmpeg 输入: bg=${bgPath}, anim=${animPath}, output=${outputPath}`)
  console.log(`媒体位置: x=${mediaInfo.x}, y=${mediaInfo.y}, w=${mediaInfo.width}, h=${mediaInfo.height}`)
  console.log(`格式: inputFormat=${inputFormat}, outputFormat=${actualOutputFormat}`)
  console.log(`消息框颜色: ${messageBoxColor}`)

  try {
    fs.writeFileSync(bgPath, backgroundBuffer)
    fs.writeFileSync(animPath, animatedBuffer)

    console.log(`文件写入完成: bg=${backgroundBuffer.length}, anim=${animatedBuffer.length}`)

    await new Promise((resolve, reject) => {
      let filterComplex
      
      if (messageBoxColor) {
        // 填充消息框颜色，然后在动画边缘画空心边框（向内10px + 向外10px）
        const borderInner = 10  // 向内覆盖
        const borderOuter = 10  // 向外扩展
        const w = Math.round(mediaInfo.width)
        const h = Math.round(mediaInfo.height)
        const x = Math.round(mediaInfo.x)
        const y = Math.round(mediaInfo.y)
        
        filterComplex = [
          `color=${messageBoxColor}:s=${w}x${h}[msgbox]`,
          `[1:v]scale=${w}:${h}[scaled]`,
          `[msgbox][scaled]overlay=shortest=1[filled]`,
          `[0:v][filled]overlay=${x}:${y}:shortest=1[temp]`,
          // 上边框（向内+向外）
          `[temp]drawbox=x=${x - borderOuter}:y=${y - borderOuter}:w=${w + borderOuter * 2}:h=${borderInner + borderOuter}:color=${messageBoxColor}:t=fill[top]`,
          // 下边框（向内+向外）
          `[top]drawbox=x=${x - borderOuter}:y=${y + h - borderInner}:w=${w + borderOuter * 2}:h=${borderInner + borderOuter}:color=${messageBoxColor}:t=fill[bottom]`,
          // 左边框（向内+向外）
          `[bottom]drawbox=x=${x - borderOuter}:y=${y}:w=${borderInner + borderOuter}:h=${h}:color=${messageBoxColor}:t=fill[left]`,
          // 右边框（向内+向外）
          `[left]drawbox=x=${x + w - borderInner}:y=${y}:w=${borderInner + borderOuter}:h=${h}:color=${messageBoxColor}:t=fill[out]`
        ]
      } else {
        // 原始逻辑
        filterComplex = [
          `[1:v]scale=${Math.round(mediaInfo.width)}:${Math.round(mediaInfo.height)}[scaled]`,
          `[0:v][scaled]overlay=${Math.round(mediaInfo.x)}:${Math.round(mediaInfo.y)}:shortest=1[out]`
        ]
      }
      
      const command = ffmpeg()
        .input(bgPath)
        .inputOptions(['-loop', '1'])
        .input(animPath)
        .inputOptions(['-vcodec', 'libvpx-vp9'])
        .complexFilter(filterComplex)
        .outputOptions(['-map', '[out]'])

      // 对于动态输出，使用 webm 格式（libvpx-vp9）
      if (actualOutputFormat === 'webm') {
        command.outputOptions(['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '41', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'])
      } else if (actualOutputFormat === 'gif') {
        command.outputOptions(['-loop', '0'])
      } else {
        command.outputOptions(['-c:v', 'libwebp', '-loop', '0', '-lossless', '0', '-quality', '80'])
      }

      command
        .on('start', (cmd) => console.log('FFmpeg 命令:', cmd))
        .on('stderr', (line) => console.log('FFmpeg:', line))
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run()
    })

    const outputBuffer = fs.readFileSync(outputPath)
    console.log(`输出文件大小: ${outputBuffer.length} bytes, 格式: ${actualOutputFormat}`)

    return { buffer: outputBuffer, format: actualOutputFormat }
  } finally {
    try { fs.unlinkSync(bgPath) } catch (e) {}
    try { fs.unlinkSync(animPath) } catch (e) {}
    try { fs.unlinkSync(outputPath) } catch (e) {}
  }
}

async function getAnimatedMediaBuffer (mediaUrl) {
  const loadImageFromUrl = require('./image-load-url')
  const buffer = await loadImageFromUrl(mediaUrl)
  return buffer
}

module.exports = {
  isAnimatedMedia,
  overlayAnimatedMedia,
  getAnimatedMediaBuffer,
  extractFirstFrame
}
