export async function readAdminInput(stream = process.stdin) {
  const chunks=[]; let size=0;
  for await (const chunk of stream) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if(size>8192)throw new Error('Entrada excedida');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
