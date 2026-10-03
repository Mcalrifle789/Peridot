/* peridot-hash — PBKDF2-HMAC-SHA256 password hashing for Peridot.
 *
 *   peridot-hash <salt-hex> <iterations>  < password
 *
 * Reads the password bytes from stdin (so it never appears in the process
 * list) and prints the 32-byte derived key as lowercase hex.
 * Exit codes: 0 ok, 2 usage, 3 input error.
 *
 * Self-contained: SHA-256 (FIPS 180-4), HMAC (RFC 2104), PBKDF2 (RFC 8018).
 * HMAC inner/outer pads are hashed once and reused for every iteration.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#define MAX_PASSWORD 4096
#define MAX_SALT 128
#define MAX_ITERATIONS 10000000UL

typedef struct {
    uint32_t h[8];
    uint64_t len;
    uint8_t buf[64];
    size_t n;
} sha256_ctx;

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_compress(uint32_t h[8], const uint8_t blk[64]) {
    uint32_t w[64], a, b, c, d, e, f, g, hh;
    int i;
    for (i = 0; i < 16; i++) {
        w[i] = (uint32_t)blk[4 * i] << 24 | (uint32_t)blk[4 * i + 1] << 16 |
               (uint32_t)blk[4 * i + 2] << 8 | (uint32_t)blk[4 * i + 3];
    }
    for (i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4]; f = h[5]; g = h[6]; hh = h[7];
    for (i = 0; i < 64; i++) {
        uint32_t t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
        uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

static void sha256_init(sha256_ctx *s) {
    static const uint32_t iv[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    };
    memcpy(s->h, iv, sizeof iv);
    s->len = 0;
    s->n = 0;
}

static void sha256_update(sha256_ctx *s, const uint8_t *data, size_t len) {
    s->len += len;
    while (len > 0) {
        size_t take = 64 - s->n < len ? 64 - s->n : len;
        memcpy(s->buf + s->n, data, take);
        s->n += take;
        data += take;
        len -= take;
        if (s->n == 64) {
            sha256_compress(s->h, s->buf);
            s->n = 0;
        }
    }
}

static void sha256_final(sha256_ctx *s, uint8_t out[32]) {
    uint64_t bits = s->len * 8;
    int i;
    s->buf[s->n++] = 0x80;
    if (s->n > 56) {
        memset(s->buf + s->n, 0, 64 - s->n);
        sha256_compress(s->h, s->buf);
        s->n = 0;
    }
    memset(s->buf + s->n, 0, 56 - s->n);
    for (i = 0; i < 8; i++) s->buf[56 + i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_compress(s->h, s->buf);
    for (i = 0; i < 8; i++) {
        out[4 * i] = (uint8_t)(s->h[i] >> 24);
        out[4 * i + 1] = (uint8_t)(s->h[i] >> 16);
        out[4 * i + 2] = (uint8_t)(s->h[i] >> 8);
        out[4 * i + 3] = (uint8_t)s->h[i];
    }
}

typedef struct {
    sha256_ctx inner, outer; /* states after absorbing key^ipad / key^opad */
} hmac_ctx;

static void wipe(void *p, size_t n) {
    volatile uint8_t *v = (volatile uint8_t *)p;
    while (n--) *v++ = 0;
}

static void hmac_init(hmac_ctx *m, const uint8_t *key, size_t klen) {
    uint8_t k[64] = {0}, pad[64];
    int i;
    if (klen > 64) {
        sha256_ctx t;
        sha256_init(&t);
        sha256_update(&t, key, klen);
        sha256_final(&t, k);
    } else {
        memcpy(k, key, klen);
    }
    for (i = 0; i < 64; i++) pad[i] = k[i] ^ 0x36;
    sha256_init(&m->inner);
    sha256_update(&m->inner, pad, 64);
    for (i = 0; i < 64; i++) pad[i] = k[i] ^ 0x5c;
    sha256_init(&m->outer);
    sha256_update(&m->outer, pad, 64);
    wipe(k, sizeof k);
    wipe(pad, sizeof pad);
}

static void hmac(const hmac_ctx *m, const uint8_t *msg, size_t len, uint8_t out[32]) {
    uint8_t ih[32];
    sha256_ctx c = m->inner;
    sha256_update(&c, msg, len);
    sha256_final(&c, ih);
    c = m->outer;
    sha256_update(&c, ih, 32);
    sha256_final(&c, out);
}

/* PBKDF2-HMAC-SHA256 with a 32-byte output (exactly one block). */
static void pbkdf2_sha256(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t saltlen,
                          unsigned long iterations, uint8_t out[32]) {
    hmac_ctx m;
    uint8_t first[MAX_SALT + 4], u[32];
    unsigned long i;
    int j;
    hmac_init(&m, pw, pwlen);
    memcpy(first, salt, saltlen);
    first[saltlen] = 0; first[saltlen + 1] = 0; first[saltlen + 2] = 0; first[saltlen + 3] = 1;
    hmac(&m, first, saltlen + 4, u);
    memcpy(out, u, 32);
    for (i = 1; i < iterations; i++) {
        hmac(&m, u, 32, u);
        for (j = 0; j < 32; j++) out[j] ^= u[j];
    }
    wipe(&m, sizeof m);
    wipe(u, sizeof u);
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int main(int argc, char **argv) {
    uint8_t salt[MAX_SALT], pw[MAX_PASSWORD + 1], dk[32];
    size_t saltlen, pwlen = 0, i, got;
    unsigned long iterations;
    char *end;

    if (argc != 3) {
        fprintf(stderr, "usage: peridot-hash <salt-hex> <iterations>  < password\n");
        return 2;
    }
    saltlen = strlen(argv[1]);
    if (saltlen == 0 || saltlen % 2 || saltlen / 2 > MAX_SALT) {
        fprintf(stderr, "peridot-hash: salt must be 1-%d bytes of hex\n", MAX_SALT);
        return 2;
    }
    for (i = 0; i < saltlen / 2; i++) {
        int hi = hexval(argv[1][2 * i]), lo = hexval(argv[1][2 * i + 1]);
        if (hi < 0 || lo < 0) {
            fprintf(stderr, "peridot-hash: salt is not valid hex\n");
            return 2;
        }
        salt[i] = (uint8_t)(hi << 4 | lo);
    }
    saltlen /= 2;
    iterations = strtoul(argv[2], &end, 10);
    if (*argv[2] == '\0' || *end != '\0' || iterations < 1 || iterations > MAX_ITERATIONS) {
        fprintf(stderr, "peridot-hash: iterations must be 1-%lu\n", MAX_ITERATIONS);
        return 2;
    }

#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    while ((got = fread(pw + pwlen, 1, sizeof pw - pwlen, stdin)) > 0) {
        pwlen += got;
        if (pwlen > MAX_PASSWORD) {
            wipe(pw, sizeof pw);
            fprintf(stderr, "peridot-hash: password longer than %d bytes\n", MAX_PASSWORD);
            return 3;
        }
    }
    if (ferror(stdin)) {
        wipe(pw, sizeof pw);
        fprintf(stderr, "peridot-hash: cannot read password from stdin\n");
        return 3;
    }

    pbkdf2_sha256(pw, pwlen, salt, saltlen, iterations, dk);
    wipe(pw, sizeof pw);
    for (i = 0; i < 32; i++) printf("%02x", dk[i]);
    printf("\n");
    wipe(dk, sizeof dk);
    return 0;
}
