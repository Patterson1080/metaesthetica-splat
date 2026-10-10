import type { GSplatData, GSplatResourceBase } from 'playcanvas'

type Storage = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array

interface PlyProperty {
  name: string
  type: string
  storage: Storage | null
}

const writers: Record<string, { size: number; write: (view: DataView, offset: number, value: number) => void }> = {
  char: { size: 1, write: (v, o, x) => v.setInt8(o, x) },
  uchar: { size: 1, write: (v, o, x) => v.setUint8(o, x) },
  short: { size: 2, write: (v, o, x) => v.setInt16(o, x, true) },
  ushort: { size: 2, write: (v, o, x) => v.setUint16(o, x, true) },
  int: { size: 4, write: (v, o, x) => v.setInt32(o, x, true) },
  uint: { size: 4, write: (v, o, x) => v.setUint32(o, x, true) },
  float: { size: 4, write: (v, o, x) => v.setFloat32(o, x, true) },
  double: { size: 8, write: (v, o, x) => v.setFloat64(o, x, true) },
}

const ROWS_PER_CHUNK = 65536

/** The uncompressed gaussians behind a resource, whatever format it was loaded from. */
async function fullData(resource: GSplatResourceBase): Promise<GSplatData> {
  const data = resource.gsplatData as unknown as { decompress?: () => GSplatData | Promise<GSplatData> }
  // compressed .ply and SOG keep quantized data; both can expand to plain 3DGS properties
  if (typeof data.decompress === 'function') return data.decompress()
  return resource.gsplatData as GSplatData
}

/**
 * Write the splats for which `keep(i)` is true as a standard binary 3DGS .ply. Every
 * per-splat property the source carried (including spherical harmonics) is preserved, so
 * the result opens in any splat tool and can be compressed to .sog afterwards.
 */
export async function exportPly(resource: GSplatResourceBase, keep: (index: number) => boolean): Promise<{ blob: Blob; count: number }> {
  const data = await fullData(resource)
  const vertex = data.getElement('vertex')
  if (!vertex) throw new Error('This splat has no editable per-splat data')

  const props = (vertex.properties as PlyProperty[]).filter((p) => p.storage && writers[p.type])
  const total = data.numSplats
  const rows: number[] = []
  for (let i = 0; i < total; i++) if (keep(i)) rows.push(i)

  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment exported by splat-engine',
    `element vertex ${rows.length}`,
    ...props.map((p) => `property ${p.type} ${p.name}`),
    'end_header',
    '',
  ].join('\n')

  const rowSize = props.reduce((sum, p) => sum + writers[p.type].size, 0)
  const parts: BlobPart[] = [new TextEncoder().encode(header)]

  // built in slices so a multi-million-splat export never needs one giant buffer
  for (let start = 0; start < rows.length; start += ROWS_PER_CHUNK) {
    const end = Math.min(start + ROWS_PER_CHUNK, rows.length)
    const buffer = new ArrayBuffer((end - start) * rowSize)
    const view = new DataView(buffer)
    let column = 0
    for (const prop of props) {
      const { size, write } = writers[prop.type]
      const storage = prop.storage!
      for (let r = start, offset = column; r < end; r++, offset += rowSize) write(view, offset, storage[rows[r]])
      column += size
    }
    parts.push(buffer)
    // let the UI breathe between slices
    await new Promise((resolve) => setTimeout(resolve))
  }

  return { blob: new Blob(parts, { type: 'application/octet-stream' }), count: rows.length }
}

/** Hand a blob to the browser as a file download. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // the click only queues the download; revoke after it has had time to start
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
