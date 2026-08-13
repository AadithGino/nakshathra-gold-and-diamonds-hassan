// Cloudflare Workers currently cap one WebCrypto PBKDF2 operation at 100,000
// iterations. The encoded hash stores this value, so the Node deployment can
// transparently verify and later rehash these temporary testing accounts.
const passwordIterations = 100_000;
const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');

const derivePassword = async (password: string, salt: Uint8Array, iterations: number) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const saltBuffer = new Uint8Array(salt).buffer;
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
};

const safeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
};

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt, passwordIterations);
  return `pbkdf2-sha256$${passwordIterations}$${encode(salt)}$${encode(derived)}`;
}

export async function verifyPassword(stored: string, password: string) {
  const [algorithm, iterationsValue, saltValue, hashValue] = stored.split('$');
  const iterations = Number(iterationsValue);
  if (
    algorithm !== 'pbkdf2-sha256' ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    !saltValue ||
    !hashValue
  )
    return false;
  const salt = new Uint8Array(Buffer.from(saltValue, 'base64url'));
  const expected = new Uint8Array(Buffer.from(hashValue, 'base64url'));
  return safeEqual(await derivePassword(password, salt, iterations), expected);
}
