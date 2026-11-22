// Zero-dependency WebGL2 scene engine for the device viewers: the three.js subset they use, one PBR program and a GLB reader.

type Listener = () => void;
const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class Vector2 {
  x: number;
  y: number;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  }
  clone() {
    return new Vector2(this.x, this.y);
  }
  copy(v: Vector2) {
    return this.set(v.x, v.y);
  }
  multiplyScalar(s: number) {
    return this.set(this.x * s, this.y * s);
  }
  addScaledVector(v: Vector2, s: number) {
    return this.set(this.x + v.x * s, this.y + v.y * s);
  }
  fromBufferAttribute(a: BufferAttribute, i: number) {
    return this.set(a.getX(i), a.getY(i));
  }
}

export class Vector3 {
  x: number;
  y: number;
  z: number;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  copy(v: Vector3) {
    return this.set(v.x, v.y, v.z);
  }
  add(v: Vector3) {
    return this.set(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  sub(v: Vector3) {
    return this.set(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  subVectors(a: Vector3, b: Vector3) {
    return this.set(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  addScaledVector(v: Vector3, s: number) {
    return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }
  multiplyScalar(s: number) {
    return this.set(this.x * s, this.y * s, this.z * s);
  }
  divideScalar(s: number) {
    return this.multiplyScalar(1 / s);
  }
  negate() {
    return this.set(-this.x, -this.y, -this.z);
  }
  dot(v: Vector3) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: Vector3) {
    return this.set(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }
  lengthSq() {
    return this.dot(this);
  }
  length() {
    return Math.sqrt(this.lengthSq());
  }
  normalize() {
    return this.divideScalar(this.length() || 1);
  }
  distanceTo(v: Vector3) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  clampLength(min: number, max: number) {
    const length = this.length();
    return this.divideScalar(length || 1).multiplyScalar(clamp(length, min, max));
  }
  lerp(v: Vector3, t: number) {
    return this.set(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }
  applyQuaternion(q: Quaternion) {
    const { x, y, z } = this;
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    return this.set(
      x + q.w * tx + q.y * tz - q.z * ty,
      y + q.w * ty + q.z * tx - q.x * tz,
      z + q.w * tz + q.x * ty - q.y * tx,
    );
  }
  applyMatrix4(m: Matrix4) {
    const { x, y, z } = this;
    const e = m.elements;
    const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
    return this.set(
      (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w,
      (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w,
      (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w,
    );
  }
  transformDirection(m: Matrix4) {
    const { x, y, z } = this;
    const e = m.elements;
    return this.set(
      e[0]! * x + e[4]! * y + e[8]! * z,
      e[1]! * x + e[5]! * y + e[9]! * z,
      e[2]! * x + e[6]! * y + e[10]! * z,
    ).normalize();
  }
  setFromMatrixPosition(m: Matrix4) {
    return this.set(m.elements[12]!, m.elements[13]!, m.elements[14]!);
  }
  fromBufferAttribute(a: BufferAttribute, i: number) {
    return this.set(a.getX(i), a.getY(i), a.getZ(i));
  }
  toArray() {
    return [this.x, this.y, this.z];
  }
}

export class Quaternion {
  _x: number;
  _y: number;
  _z: number;
  _w: number;
  _onChange: Listener = () => {};
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._w = w;
  }
  get x() {
    return this._x;
  }
  get y() {
    return this._y;
  }
  get z() {
    return this._z;
  }
  get w() {
    return this._w;
  }
  set(x: number, y: number, z: number, w: number) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._w = w;
    this._onChange();
    return this;
  }
  clone() {
    return new Quaternion(this._x, this._y, this._z, this._w);
  }
  copy(q: Quaternion) {
    return this.set(q._x, q._y, q._z, q._w);
  }
  length() {
    return Math.hypot(this._x, this._y, this._z, this._w);
  }
  normalize() {
    const l = this.length();
    return l === 0 ? this.set(0, 0, 0, 1) : this.set(this._x / l, this._y / l, this._z / l, this._w / l);
  }
  invert() {
    return this.set(-this._x, -this._y, -this._z, this._w);
  }
  dot(q: Quaternion) {
    return this._x * q._x + this._y * q._y + this._z * q._z + this._w * q._w;
  }
  multiplyQuaternions(a: Quaternion, b: Quaternion) {
    const { _x: ax, _y: ay, _z: az, _w: aw } = a;
    const { _x: bx, _y: by, _z: bz, _w: bw } = b;
    return this.set(
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  }
  multiply(q: Quaternion) {
    return this.multiplyQuaternions(this, q);
  }
  premultiply(q: Quaternion) {
    return this.multiplyQuaternions(q, this);
  }
  setFromAxisAngle(axis: Vector3, angle: number) {
    const s = Math.sin(angle / 2);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2));
  }
  setFromEuler(e: Euler) {
    const [c1, c2, c3] = [e.x, e.y, e.z].map((v) => Math.cos(v / 2)) as [number, number, number];
    const [s1, s2, s3] = [e.x, e.y, e.z].map((v) => Math.sin(v / 2)) as [number, number, number];
    return e.order === "YXZ"
      ? this.set(
          s1 * c2 * c3 + c1 * s2 * s3,
          c1 * s2 * c3 - s1 * c2 * s3,
          c1 * c2 * s3 - s1 * s2 * c3,
          c1 * c2 * c3 + s1 * s2 * s3,
        )
      : this.set(
          s1 * c2 * c3 + c1 * s2 * s3,
          c1 * s2 * c3 - s1 * c2 * s3,
          c1 * c2 * s3 + s1 * s2 * c3,
          c1 * c2 * c3 - s1 * s2 * s3,
        );
  }
  setFromRotationMatrix(m: Matrix4) {
    const e = m.elements;
    const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = [
      e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!,
    ];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
    }
    if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
    }
    if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
    }
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
  angleTo(q: Quaternion) {
    return 2 * Math.acos(Math.abs(clamp(this.dot(q), -1, 1)));
  }
  slerp(q: Quaternion, t: number) {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);
    let { _x: x, _y: y, _z: z, _w: w } = q;
    let cos = this.dot(q);
    if (cos < 0) {
      [x, y, z, w, cos] = [-x, -y, -z, -w, -cos];
    }
    if (cos >= 1) return this;
    const sqrSin = 1 - cos * cos;
    if (sqrSin <= Number.EPSILON) {
      const s = 1 - t;
      return this.set(s * this._x + t * x, s * this._y + t * y, s * this._z + t * z, s * this._w + t * w).normalize();
    }
    const sin = Math.sqrt(sqrSin);
    const half = Math.atan2(sin, cos);
    const a = Math.sin((1 - t) * half) / sin;
    const b = Math.sin(t * half) / sin;
    return this.set(this._x * a + x * b, this._y * a + y * b, this._z * a + z * b, this._w * a + w * b);
  }
}

export class Euler {
  _onChange: Listener = () => {};
  private _x: number;
  private _y: number;
  private _z: number;
  order: "XYZ" | "YXZ";
  constructor(x = 0, y = 0, z = 0, order: "XYZ" | "YXZ" = "XYZ") {
    this._x = x;
    this._y = y;
    this._z = z;
    this.order = order;
  }
  get x() {
    return this._x;
  }
  set x(v) {
    this._x = v;
    this._onChange();
  }
  get y() {
    return this._y;
  }
  set y(v) {
    this._y = v;
    this._onChange();
  }
  get z() {
    return this._z;
  }
  set z(v) {
    this._z = v;
    this._onChange();
  }
  setFromQuaternion(q: Quaternion) {
    const e = new Matrix4().makeRotationFromQuaternion(q).elements;
    const [m11, m12, m13, m22, m23, m32, m33] = [e[0]!, e[4]!, e[8]!, e[5]!, e[9]!, e[6]!, e[10]!];
    this._y = Math.asin(clamp(m13, -1, 1));
    if (Math.abs(m13) < 0.9999999) {
      this._x = Math.atan2(-m23, m33);
      this._z = Math.atan2(-m12, m11);
    } else {
      this._x = Math.atan2(m32, m22);
      this._z = 0;
    }
    return this;
  }
}

export class Matrix4 {
  elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  set(...values: number[]) {
    // Row-major arguments, column-major storage.
    for (let row = 0; row < 4; row++)
      for (let column = 0; column < 4; column++) this.elements[column * 4 + row] = values[row * 4 + column]!;
    return this;
  }
  identity() {
    return this.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  }
  clone() {
    return new Matrix4().copy(this);
  }
  copy(m: Matrix4) {
    this.elements = m.elements.slice();
    return this;
  }
  fromArray(values: ArrayLike<number>) {
    this.elements = Array.from(values);
    return this;
  }
  multiplyMatrices(a: Matrix4, b: Matrix4) {
    const ae = a.elements;
    const be = b.elements;
    const out = new Array<number>(16);
    for (let column = 0; column < 4; column++)
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += ae[k * 4 + row]! * be[column * 4 + k]!;
        out[column * 4 + row] = sum;
      }
    this.elements = out;
    return this;
  }
  multiply(m: Matrix4) {
    return this.multiplyMatrices(this, m);
  }
  premultiply(m: Matrix4) {
    return this.multiplyMatrices(m, this);
  }
  private invertRaw() {
    const m = this.elements;
    const inv = new Array<number>(16);
    inv[0] = m[5]! * m[10]! * m[15]! - m[5]! * m[11]! * m[14]! - m[9]! * m[6]! * m[15]! + m[9]! * m[7]! * m[14]! + m[13]! * m[6]! * m[11]! - m[13]! * m[7]! * m[10]!;
    inv[4] = -m[4]! * m[10]! * m[15]! + m[4]! * m[11]! * m[14]! + m[8]! * m[6]! * m[15]! - m[8]! * m[7]! * m[14]! - m[12]! * m[6]! * m[11]! + m[12]! * m[7]! * m[10]!;
    inv[8] = m[4]! * m[9]! * m[15]! - m[4]! * m[11]! * m[13]! - m[8]! * m[5]! * m[15]! + m[8]! * m[7]! * m[13]! + m[12]! * m[5]! * m[11]! - m[12]! * m[7]! * m[9]!;
    inv[12] = -m[4]! * m[9]! * m[14]! + m[4]! * m[10]! * m[13]! + m[8]! * m[5]! * m[14]! - m[8]! * m[6]! * m[13]! - m[12]! * m[5]! * m[10]! + m[12]! * m[6]! * m[9]!;
    inv[1] = -m[1]! * m[10]! * m[15]! + m[1]! * m[11]! * m[14]! + m[9]! * m[2]! * m[15]! - m[9]! * m[3]! * m[14]! - m[13]! * m[2]! * m[11]! + m[13]! * m[3]! * m[10]!;
    inv[5] = m[0]! * m[10]! * m[15]! - m[0]! * m[11]! * m[14]! - m[8]! * m[2]! * m[15]! + m[8]! * m[3]! * m[14]! + m[12]! * m[2]! * m[11]! - m[12]! * m[3]! * m[10]!;
    inv[9] = -m[0]! * m[9]! * m[15]! + m[0]! * m[11]! * m[13]! + m[8]! * m[1]! * m[15]! - m[8]! * m[3]! * m[13]! - m[12]! * m[1]! * m[11]! + m[12]! * m[3]! * m[9]!;
    inv[13] = m[0]! * m[9]! * m[14]! - m[0]! * m[10]! * m[13]! - m[8]! * m[1]! * m[14]! + m[8]! * m[2]! * m[13]! + m[12]! * m[1]! * m[10]! - m[12]! * m[2]! * m[9]!;
    inv[2] = m[1]! * m[6]! * m[15]! - m[1]! * m[7]! * m[14]! - m[5]! * m[2]! * m[15]! + m[5]! * m[3]! * m[14]! + m[13]! * m[2]! * m[7]! - m[13]! * m[3]! * m[6]!;
    inv[6] = -m[0]! * m[6]! * m[15]! + m[0]! * m[7]! * m[14]! + m[4]! * m[2]! * m[15]! - m[4]! * m[3]! * m[14]! - m[12]! * m[2]! * m[7]! + m[12]! * m[3]! * m[6]!;
    inv[10] = m[0]! * m[5]! * m[15]! - m[0]! * m[7]! * m[13]! - m[4]! * m[1]! * m[15]! + m[4]! * m[3]! * m[13]! + m[12]! * m[1]! * m[7]! - m[12]! * m[3]! * m[5]!;
    inv[14] = -m[0]! * m[5]! * m[14]! + m[0]! * m[6]! * m[13]! + m[4]! * m[1]! * m[14]! - m[4]! * m[2]! * m[13]! - m[12]! * m[1]! * m[6]! + m[12]! * m[2]! * m[5]!;
    inv[3] = -m[1]! * m[6]! * m[11]! + m[1]! * m[7]! * m[10]! + m[5]! * m[2]! * m[11]! - m[5]! * m[3]! * m[10]! - m[9]! * m[2]! * m[7]! + m[9]! * m[3]! * m[6]!;
    inv[7] = m[0]! * m[6]! * m[11]! - m[0]! * m[7]! * m[10]! - m[4]! * m[2]! * m[11]! + m[4]! * m[3]! * m[10]! + m[8]! * m[2]! * m[7]! - m[8]! * m[3]! * m[6]!;
    inv[11] = -m[0]! * m[5]! * m[11]! + m[0]! * m[7]! * m[9]! + m[4]! * m[1]! * m[11]! - m[4]! * m[3]! * m[9]! - m[8]! * m[1]! * m[7]! + m[8]! * m[3]! * m[5]!;
    inv[15] = m[0]! * m[5]! * m[10]! - m[0]! * m[6]! * m[9]! - m[4]! * m[1]! * m[10]! + m[4]! * m[2]! * m[9]! + m[8]! * m[1]! * m[6]! - m[8]! * m[2]! * m[5]!;
    const det = m[0]! * inv[0] + m[1]! * inv[4] + m[2]! * inv[8] + m[3]! * inv[12];
    return { inv, det };
  }
  invert() {
    const { inv, det } = this.invertRaw();
    this.elements = det === 0 ? new Array<number>(16).fill(0) : inv.map((v) => v / det);
    return this;
  }
  compose(p: Vector3, q: Quaternion, s: Vector3) {
    this.makeRotationFromQuaternion(q);
    const e = this.elements;
    for (let i = 0; i < 3; i++) {
      e[i] = e[i]! * s.x;
      e[4 + i] = e[4 + i]! * s.y;
      e[8 + i] = e[8 + i]! * s.z;
    }
    e[12] = p.x;
    e[13] = p.y;
    e[14] = p.z;
    return this;
  }
  makeRotationFromQuaternion(q: Quaternion) {
    const { x, y, z, w } = q;
    return this.set(
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    );
  }
  makeRotationZ(theta: number) {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return this.set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  }
  makeBasis(x: Vector3, y: Vector3, z: Vector3) {
    return this.set(x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, 0, 0, 0, 1);
  }
  extractRotation(m: Matrix4) {
    const e = m.elements;
    const column = (i: number) => 1 / (Math.hypot(e[i]!, e[i + 1]!, e[i + 2]!) || 1);
    const [sx, sy, sz] = [column(0), column(4), column(8)];
    return this.set(
      e[0]! * sx, e[4]! * sy, e[8]! * sz, 0,
      e[1]! * sx, e[5]! * sy, e[9]! * sz, 0,
      e[2]! * sx, e[6]! * sy, e[10]! * sz, 0,
      0, 0, 0, 1,
    );
  }
  lookAt(eye: Vector3, target: Vector3, up: Vector3) {
    const z = eye.clone().sub(target);
    if (z.lengthSq() === 0) z.z = 1;
    z.normalize();
    const x = up.clone().cross(z);
    if (x.lengthSq() === 0) {
      z.x += 0.0001;
      x.copy(up).cross(z.normalize());
    }
    x.normalize();
    const y = z.clone().cross(x);
    const e = this.elements;
    [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]] = [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z];
    return this;
  }
  makePerspective(fov: number, aspect: number, near: number, far: number) {
    const f = 1 / Math.tan((fov * Math.PI) / 360);
    return this.set(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
      0, 0, -1, 0,
    );
  }
}

export class Box3 {
  min: Vector3;
  max: Vector3;
  constructor(min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)) {
    this.min = min;
    this.max = max;
  }
  makeEmpty() {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    return this;
  }
  isEmpty() {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }
  clone() {
    return new Box3().copy(this);
  }
  copy(b: Box3) {
    this.min.copy(b.min);
    this.max.copy(b.max);
    return this;
  }
  expandByPoint(p: Vector3) {
    this.min.set(Math.min(this.min.x, p.x), Math.min(this.min.y, p.y), Math.min(this.min.z, p.z));
    this.max.set(Math.max(this.max.x, p.x), Math.max(this.max.y, p.y), Math.max(this.max.z, p.z));
    return this;
  }
  union(b: Box3) {
    if (b.isEmpty()) return this;
    return this.expandByPoint(b.min).expandByPoint(b.max);
  }
  getCenter(target: Vector3) {
    return this.isEmpty() ? target.set(0, 0, 0) : target.copy(this.min).add(this.max).multiplyScalar(0.5);
  }
  getSize(target: Vector3) {
    return this.isEmpty() ? target.set(0, 0, 0) : target.copy(this.max).sub(this.min);
  }
  applyMatrix4(m: Matrix4) {
    if (this.isEmpty()) return this;
    const { min, max } = this;
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      new Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(m),
    );
    this.makeEmpty();
    for (const corner of corners) this.expandByPoint(corner);
    return this;
  }
  setFromObject(object: Object3D) {
    this.makeEmpty();
    const expand = (node: Object3D) => {
      node.updateWorldMatrix(false, false);
      if (node instanceof Mesh) {
        node.geometry.boundingBox ?? node.geometry.computeBoundingBox();
        this.union(node.geometry.boundingBox!.clone().applyMatrix4(node.matrixWorld));
      }
      for (const child of node.children) expand(child);
    };
    expand(object);
    return this;
  }
}

export class Plane {
  normal: Vector3;
  constant: number;
  constructor(normal = new Vector3(0, 0, 1), constant = 0) {
    this.normal = normal;
    this.constant = constant;
  }
}

export class Ray {
  origin: Vector3;
  direction: Vector3;
  constructor(origin = new Vector3(), direction = new Vector3(0, 0, -1)) {
    this.origin = origin;
    this.direction = direction;
  }
  clone() {
    return new Ray(this.origin.clone(), this.direction.clone());
  }
  at(t: number, target = new Vector3()) {
    return target.copy(this.origin).addScaledVector(this.direction, t);
  }
  applyMatrix4(m: Matrix4) {
    const tip = this.origin.clone().add(this.direction).applyMatrix4(m);
    this.origin.applyMatrix4(m);
    this.direction.copy(tip).sub(this.origin).normalize();
    return this;
  }
  intersectPlane(plane: Plane, target: Vector3) {
    const denominator = plane.normal.dot(this.direction);
    if (denominator === 0) return plane.normal.dot(this.origin) + plane.constant === 0 ? target.copy(this.origin) : null;
    const t = -(this.origin.dot(plane.normal) + plane.constant) / denominator;
    return t >= 0 ? this.at(t, target) : null;
  }
}

export class Triangle {
  a: Vector3;
  b: Vector3;
  c: Vector3;
  constructor(a = new Vector3(), b = new Vector3(), c = new Vector3()) {
    this.a = a;
    this.b = b;
    this.c = c;
  }
  getPlane(target: Plane) {
    const normal = this.c.clone().sub(this.b).cross(this.a.clone().sub(this.b)).normalize();
    target.normal.copy(normal);
    target.constant = -this.a.dot(normal);
    return target;
  }
  getBarycoord(p: Vector3, target: Vector3) {
    const v0 = this.c.clone().sub(this.a);
    const v1 = this.b.clone().sub(this.a);
    const v2 = p.clone().sub(this.a);
    const [d00, d01, d02, d11, d12] = [v0.dot(v0), v0.dot(v1), v0.dot(v2), v1.dot(v1), v1.dot(v2)];
    const denominator = d00 * d11 - d01 * d01;
    if (denominator === 0) return null;
    const u = (d11 * d02 - d01 * d12) / denominator;
    const v = (d00 * d12 - d01 * d02) / denominator;
    return target.set(1 - u - v, v, u);
  }
}

export class Color {
  r = 1;
  g = 1;
  b = 1;
  constructor(hex?: number) {
    if (hex !== undefined) this.setHex(hex);
  }
  /** sRGB hex in, linear working values stored, as three.js color management does. */
  setHex(hex: number) {
    const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    this.r = linear(((hex >> 16) & 255) / 255);
    this.g = linear(((hex >> 8) & 255) / 255);
    this.b = linear((hex & 255) / 255);
    return this;
  }
  setRGB(r: number, g: number, b: number) {
    [this.r, this.g, this.b] = [r, g, b];
    return this;
  }
}

class Disposable {
  version = 0;
  readonly disposeListeners = new Set<Listener>();
  set needsUpdate(value: boolean) {
    if (value) this.version++;
  }
  dispose() {
    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
  }
}

type AttributeArray = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array;
export class BufferAttribute extends Disposable {
  array: AttributeArray;
  itemSize: number;
  normalized: boolean;
  constructor(array: AttributeArray, itemSize: number, normalized = false) {
    super();
    this.array = array;
    this.itemSize = itemSize;
    this.normalized = normalized;
  }
  get count() {
    return this.array.length / this.itemSize;
  }
  getX(i: number) {
    return this.array[i * this.itemSize]!;
  }
  getY(i: number) {
    return this.array[i * this.itemSize + 1]!;
  }
  getZ(i: number) {
    return this.array[i * this.itemSize + 2]!;
  }
  setXY(i: number, x: number, y: number) {
    this.array[i * this.itemSize] = x;
    this.array[i * this.itemSize + 1] = y;
    return this;
  }
  setXYZ(i: number, x: number, y: number, z: number) {
    this.setXY(i, x, y).array[i * this.itemSize + 2] = z;
    return this;
  }
}
export class Float32BufferAttribute extends BufferAttribute {
  constructor(array: ArrayLike<number>, itemSize: number) {
    super(new Float32Array(array), itemSize);
  }
}

export class BufferGeometry extends Disposable {
  readonly attributes: Record<string, BufferAttribute> = {};
  index: BufferAttribute | null = null;
  boundingBox: Box3 | null = null;
  getAttribute(name: string) {
    return this.attributes[name]!;
  }
  setAttribute(name: string, attribute: BufferAttribute) {
    this.attributes[name] = attribute;
    return this;
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
  setIndex(index: ArrayLike<number> | BufferAttribute) {
    this.index =
      index instanceof BufferAttribute
        ? index
        : new BufferAttribute(index.length > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1);
    return this;
  }
  translate(x: number, y: number, z: number) {
    return this.transformPositions((p) => p.set(p.x + x, p.y + y, p.z + z));
  }
  scale(x: number, y: number, z: number) {
    return this.transformPositions((p) => p.set(p.x * x, p.y * y, p.z * z));
  }
  private transformPositions(transform: (point: Vector3) => Vector3) {
    const position = this.getAttribute("position");
    const point = new Vector3();
    for (let i = 0; i < position.count; i++) {
      transform(point.fromBufferAttribute(position, i));
      position.setXYZ(i, point.x, point.y, point.z);
    }
    position.needsUpdate = true;
    if (this.boundingBox) this.computeBoundingBox();
    return this;
  }
  computeBoundingBox() {
    const position = this.attributes.position;
    const box = (this.boundingBox ??= new Box3()).makeEmpty();
    if (!position) return;
    const point = new Vector3();
    for (let i = 0; i < position.count; i++) box.expandByPoint(point.fromBufferAttribute(position, i));
  }
  computeBoundingSphere() {
    this.computeBoundingBox();
  }
  /** Area-weighted smooth normals over shared vertices. */
  computeVertexNormals() {
    const position = this.getAttribute("position");
    const normals = new Float32Array(position.count * 3);
    const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
    forEachTriangle(this, (i0, i1, i2) => {
      a.fromBufferAttribute(position, i0);
      b.fromBufferAttribute(position, i1);
      c.fromBufferAttribute(position, i2);
      const n = c.sub(b).cross(a.sub(b));
      for (const i of [i0, i1, i2]) {
        normals[i * 3]! += n.x;
        normals[i * 3 + 1]! += n.y;
        normals[i * 3 + 2]! += n.z;
      }
    });
    for (let i = 0; i < normals.length; i += 3) {
      const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
      normals[i]! /= length;
      normals[i + 1]! /= length;
      normals[i + 2]! /= length;
    }
    this.setAttribute("normal", new BufferAttribute(normals, 3));
  }
}

function forEachTriangle(geometry: BufferGeometry, visit: (a: number, b: number, c: number) => void) {
  const index = geometry.index?.array;
  const count = index ? index.length : geometry.getAttribute("position").count;
  for (let i = 0; i + 2 < count; i += 3)
    index ? visit(index[i]!, index[i + 1]!, index[i + 2]!) : visit(i, i + 1, i + 2);
}

/** Collects triangles with positions, normals and uvs, then becomes one indexed geometry. */
class GeometryBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }
  build(geometry: BufferGeometry, smooth = false) {
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    if (smooth) geometry.computeVertexNormals();
    else geometry.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    return geometry;
  }
}

export class Shape {
  private points: Vector2[] = [];
  private segments: ((divisions: number) => Vector2[])[] = [];
  private cursor = new Vector2();
  moveTo(x: number, y: number) {
    this.cursor.set(x, y);
    this.segments.push(() => [new Vector2(x, y)]);
    return this;
  }
  lineTo(x: number, y: number) {
    this.cursor.set(x, y);
    this.segments.push(() => [new Vector2(x, y)]);
    return this;
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    const start = this.cursor.clone();
    this.cursor.set(x, y);
    this.segments.push((divisions) =>
      Array.from({ length: divisions }, (_, step) => {
        const t = (step + 1) / divisions;
        const k = 1 - t;
        return new Vector2(k * k * start.x + 2 * k * t * cx + t * t * x, k * k * start.y + 2 * k * t * cy + t * t * y);
      }),
    );
    return this;
  }
  closePath() {
    return this;
  }
  /** The outline, counter-clockwise, without a repeated closing point. */
  getPoints(divisions = 12) {
    this.points = this.segments.flatMap((segment) => segment(divisions));
    const out = this.points.filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.y !== all[i - 1]!.y);
    const last = out.at(-1);
    if (out.length > 1 && last && last.x === out[0]!.x && last.y === out[0]!.y) out.pop();
    let area = 0;
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      const b = out[(i + 1) % out.length]!;
      area += a.x * b.y - b.x * a.y;
    }
    return area < 0 ? out.reverse() : out;
  }
}

/** Convex outlines fan from their centroid. */
function capFan(builder: GeometryBuilder, outline: Vector2[], z: number, facing: 1 | -1, bounds: [number, number, number, number]) {
  const [minX, minY, width, height] = bounds;
  const uv = (p: Vector2) => [(p.x - minX) / width, (p.y - minY) / height] as const;
  const center = outline.reduce((sum, p) => sum.set(sum.x + p.x / outline.length, sum.y + p.y / outline.length), new Vector2());
  const middle = builder.vertex(center.x, center.y, z, 0, 0, facing, ...uv(center));
  const first = builder.positions.length / 3;
  for (const p of outline) builder.vertex(p.x, p.y, z, 0, 0, facing, ...uv(p));
  for (let i = 0; i < outline.length; i++) {
    const a = first + i;
    const b = first + ((i + 1) % outline.length);
    builder.indices.push(...(facing > 0 ? [middle, a, b] : [middle, b, a]));
  }
}

function outlineBounds(outline: Vector2[]): [number, number, number, number] {
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  return [minX, minY, Math.max(...xs) - minX || 1, Math.max(...ys) - minY || 1];
}

export class ShapeGeometry extends BufferGeometry {
  constructor(shape: Shape, curveSegments = 12) {
    super();
    const outline = shape.getPoints(curveSegments);
    const builder = new GeometryBuilder();
    capFan(builder, outline, 0, 1, outlineBounds(outline));
    builder.build(this);
  }
}

/** Convex outline offset by `distance` along mitred vertex normals. */
function offsetOutline(outline: Vector2[], distance: number) {
  if (!distance) return outline;
  return outline.map((p, i) => {
    const prev = outline[(i + outline.length - 1) % outline.length]!;
    const next = outline[(i + 1) % outline.length]!;
    const n1 = new Vector2(p.y - prev.y, prev.x - p.x);
    const n2 = new Vector2(next.y - p.y, p.x - next.x);
    n1.multiplyScalar(1 / (Math.hypot(n1.x, n1.y) || 1));
    n2.multiplyScalar(1 / (Math.hypot(n2.x, n2.y) || 1));
    const bisector = new Vector2(n1.x + n2.x, n1.y + n2.y);
    const length = Math.hypot(bisector.x, bisector.y) || 1;
    bisector.multiplyScalar(1 / length);
    const miter = distance / Math.max(0.25, bisector.x * n1.x + bisector.y * n1.y);
    return new Vector2(p.x + bisector.x * miter, p.y + bisector.y * miter);
  });
}

export class ExtrudeGeometry extends BufferGeometry {
  constructor(
    shape: Shape,
    options: {
      depth?: number;
      bevelEnabled?: boolean;
      bevelSize?: number;
      bevelThickness?: number;
      bevelSegments?: number;
      curveSegments?: number;
      steps?: number;
    } = {},
  ) {
    super();
    const depth = options.depth ?? 1;
    const bevel = options.bevelEnabled ?? true;
    const size = bevel ? (options.bevelSize ?? 0.1) : 0;
    const thickness = bevel ? (options.bevelThickness ?? 0.2) : 0;
    const segments = bevel ? (options.bevelSegments ?? 3) : 0;
    const outline = shape.getPoints(options.curveSegments ?? 12);
    // Rings from back cap to front cap, as three.js bevels: quarter-circle profile out to `size` at z 0 and depth.
    const rings: { offset: number; z: number }[] = [];
    for (let b = 0; b <= segments; b++) {
      const t = segments ? b / segments : 1;
      rings.push({ offset: size * Math.sin((t * Math.PI) / 2), z: -thickness * Math.cos((t * Math.PI) / 2) });
    }
    for (let b = segments; b >= 0; b--) {
      const t = segments ? b / segments : 1;
      rings.push({ offset: size * Math.sin((t * Math.PI) / 2), z: depth + thickness * Math.cos((t * Math.PI) / 2) });
    }
    const sides = new GeometryBuilder();
    const contours = rings.map((ring) => offsetOutline(outline, ring.offset));
    const n = outline.length;
    contours.forEach((contour, r) => {
      contour.forEach((p, i) => sides.vertex(p.x, p.y, rings[r]!.z, 0, 0, 0, i / n, r / (rings.length - 1)));
    });
    for (let r = 0; r + 1 < rings.length; r++)
      for (let i = 0; i < n; i++) {
        const a = r * n + i;
        const b = r * n + ((i + 1) % n);
        const c = (r + 1) * n + ((i + 1) % n);
        const d = (r + 1) * n + i;
        sides.indices.push(a, b, d, b, c, d);
      }
    const caps = new GeometryBuilder();
    const bounds = outlineBounds(outline);
    capFan(caps, contours[0]!, rings[0]!.z, -1, bounds);
    capFan(caps, contours.at(-1)!, rings.at(-1)!.z, 1, bounds);
    mergeInto(this, [sides.build(new BufferGeometry(), true), caps.build(new BufferGeometry())]);
  }
}

function mergeInto(target: BufferGeometry, parts: BufferGeometry[]) {
  const merged = { position: [] as number[], normal: [] as number[], uv: [] as number[], index: [] as number[] };
  for (const part of parts) {
    const offset = merged.position.length / 3;
    merged.position.push(...part.getAttribute("position").array);
    merged.normal.push(...part.getAttribute("normal").array);
    merged.uv.push(...part.getAttribute("uv").array);
    merged.index.push(...Array.from(part.index?.array ?? [], (i) => i + offset));
  }
  target.setAttribute("position", new Float32BufferAttribute(merged.position, 3));
  target.setAttribute("normal", new Float32BufferAttribute(merged.normal, 3));
  target.setAttribute("uv", new Float32BufferAttribute(merged.uv, 2));
  target.setIndex(merged.index);
}

export class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, widthSegments = 1, heightSegments = 1) {
    super();
    const builder = new GeometryBuilder();
    for (let iy = 0; iy <= heightSegments; iy++)
      for (let ix = 0; ix <= widthSegments; ix++)
        builder.vertex(
          (ix / widthSegments - 0.5) * width,
          (0.5 - iy / heightSegments) * height,
          0, 0, 0, 1,
          ix / widthSegments,
          1 - iy / heightSegments,
        );
    for (let iy = 0; iy < heightSegments; iy++)
      for (let ix = 0; ix < widthSegments; ix++) {
        const a = ix + (widthSegments + 1) * iy;
        const b = a + widthSegments + 1;
        builder.indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    builder.build(this);
  }
}

export class CircleGeometry extends BufferGeometry {
  constructor(radius = 1, segments = 32) {
    super();
    const builder = new GeometryBuilder();
    builder.vertex(0, 0, 0, 0, 0, 1, 0.5, 0.5);
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * TAU;
      const [c, s] = [Math.cos(theta), Math.sin(theta)];
      builder.vertex(radius * c, radius * s, 0, 0, 0, 1, (c + 1) / 2, (s + 1) / 2);
      if (i) builder.indices.push(i, i + 1, 0);
    }
    builder.build(this);
  }
}

export class CylinderGeometry extends BufferGeometry {
  constructor(
    radiusTop = 1,
    radiusBottom = 1,
    height = 1,
    radialSegments = 32,
    heightSegments = 1,
    openEnded = false,
    thetaStart = 0,
    thetaLength = TAU,
  ) {
    super();
    const builder = new GeometryBuilder();
    const slope = (radiusBottom - radiusTop) / height;
    for (let y = 0; y <= heightSegments; y++) {
      const v = y / heightSegments;
      const radius = v * (radiusBottom - radiusTop) + radiusTop;
      for (let x = 0; x <= radialSegments; x++) {
        const theta = (x / radialSegments) * thetaLength + thetaStart;
        const [s, c] = [Math.sin(theta), Math.cos(theta)];
        const normal = new Vector3(s, slope, c).normalize();
        builder.vertex(radius * s, -v * height + height / 2, radius * c, normal.x, normal.y, normal.z, x / radialSegments, 1 - v);
      }
    }
    for (let x = 0; x < radialSegments; x++)
      for (let y = 0; y < heightSegments; y++) {
        const row = radialSegments + 1;
        const [a, b] = [y * row + x, (y + 1) * row + x];
        builder.indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    if (!openEnded)
      for (const top of [true, false]) {
        const radius = top ? radiusTop : radiusBottom;
        const sign = top ? 1 : -1;
        const center = builder.vertex(0, (height / 2) * sign, 0, 0, sign, 0, 0.5, 0.5);
        const first = builder.positions.length / 3;
        for (let x = 0; x <= radialSegments; x++) {
          const theta = (x / radialSegments) * thetaLength + thetaStart;
          const [s, c] = [Math.sin(theta), Math.cos(theta)];
          builder.vertex(radius * s, (height / 2) * sign, radius * c, 0, sign, 0, (s + 1) / 2, (c * sign + 1) / 2);
        }
        for (let x = 0; x < radialSegments; x++)
          builder.indices.push(...(top ? [first + x, first + x + 1, center] : [first + x + 1, first + x, center]));
      }
    builder.build(this);
  }
}

export class BoxGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, depth = 1) {
    super();
    const builder = new GeometryBuilder();
    const half = new Vector3(width / 2, height / 2, depth / 2);
    for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]] as const) {
      const normal = [0, 0, 0];
      normal[axis] = sign;
      const u = [0, 0, 0];
      const v = [0, 0, 0];
      u[(axis + 1) % 3] = 1;
      v[(axis + 2) % 3] = 1;
      const first = builder.positions.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const p = [0, 1, 2].map((k) => (normal[k]! + u[k]! * su + v[k]! * sv) * [half.x, half.y, half.z][k]!);
        builder.vertex(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, (su + 1) / 2, (sv + 1) / 2);
      }
      builder.indices.push(...(sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((i) => i + first));
    }
    builder.build(this);
  }
}

export class Texture extends Disposable {
  flipY = true;
  colorSpace: "srgb" | "linear" = "srgb";
  repeat = true;
  mipmaps = false;
  image: TexImageSource | null;
  constructor(image: TexImageSource | null = null) {
    super();
    this.image = image;
  }
}
export class CanvasTexture extends Texture {
  constructor(image: TexImageSource) {
    super(image);
    this.repeat = false;
  }
}

export const FrontSide = 0;
export const DoubleSide = 2;
type MaterialOptions = Partial<{
  color: number;
  map: Texture | null;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  colorWrite: boolean;
  depthWrite: boolean;
  toneMapped: boolean;
}>;
export class MeshBasicMaterial extends Disposable {
  readonly unlit: boolean = true;
  name = "";
  color = new Color();
  map: Texture | null = null;
  opacity = 1;
  transparent = false;
  alphaTest = 0;
  colorWrite = true;
  depthWrite = true;
  side = FrontSide;
  vertexColors = false;
  constructor(options: MaterialOptions = {}) {
    super();
    if (options.color !== undefined) this.color.setHex(options.color);
    this.map = options.map ?? null;
    this.colorWrite = options.colorWrite ?? true;
    this.depthWrite = options.depthWrite ?? true;
  }
  textures(): Texture[] {
    return this.map ? [this.map] : [];
  }
}
export class MeshStandardMaterial extends MeshBasicMaterial {
  override readonly unlit: boolean = false;
  metalness: number;
  roughness: number;
  clearcoat = 0;
  clearcoatRoughness = 0;
  metalnessMap: Texture | null = null;
  normalMap: Texture | null = null;
  normalScale = new Vector2(1, 1);
  emissive = new Color().setRGB(0, 0, 0);
  emissiveMap: Texture | null = null;
  aoMap: Texture | null = null;
  constructor(options: MaterialOptions = {}) {
    super(options);
    this.metalness = options.metalness ?? 0;
    this.roughness = options.roughness ?? 1;
  }
  override textures() {
    return [this.map, this.metalnessMap, this.normalMap, this.emissiveMap, this.aoMap].filter((t): t is Texture => !!t);
  }
}
export class MeshPhysicalMaterial extends MeshStandardMaterial {
  constructor(options: MaterialOptions = {}) {
    super(options);
    this.clearcoat = options.clearcoat ?? 0;
    this.clearcoatRoughness = options.clearcoatRoughness ?? 0;
  }
}
export type Material = MeshBasicMaterial;

export class Object3D {
  readonly type: string = "Object3D";
  name = "";
  parent: Object3D | null = null;
  readonly children: Object3D[] = [];
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly rotation = new Euler();
  readonly scale = new Vector3(1, 1, 1);
  readonly matrix = new Matrix4();
  matrixWorld = new Matrix4();
  visible = true;
  constructor() {
    this.rotation._onChange = () => {
      const handler = this.quaternion._onChange;
      this.quaternion._onChange = () => {};
      this.quaternion.setFromEuler(this.rotation);
      this.quaternion._onChange = handler;
    };
    this.quaternion._onChange = () => this.rotation.setFromQuaternion(this.quaternion);
  }
  add(...objects: Object3D[]) {
    for (const object of objects) {
      object.removeFromParent();
      object.parent = this;
      this.children.push(object);
    }
    return this;
  }
  remove(...objects: Object3D[]) {
    for (const object of objects) {
      const index = this.children.indexOf(object);
      if (index < 0) continue;
      this.children.splice(index, 1);
      object.parent = null;
    }
    return this;
  }
  removeFromParent() {
    this.parent?.remove(this);
    return this;
  }
  traverse(visit: (object: Object3D) => void) {
    visit(this);
    for (const child of this.children.slice()) child.traverse(visit);
  }
  getObjectByName(name: string): Object3D | undefined {
    if (this.name === name) return this;
    for (const child of this.children) {
      const found = child.getObjectByName(name);
      if (found) return found;
    }
    return undefined;
  }
  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
  }
  updateWorldMatrix(updateParents: boolean, updateChildren: boolean) {
    if (updateParents) this.parent?.updateWorldMatrix(true, false);
    this.updateMatrix();
    this.matrixWorld = this.parent ? new Matrix4().multiplyMatrices(this.parent.matrixWorld, this.matrix) : this.matrix.clone();
    if (updateChildren) for (const child of this.children) child.updateWorldMatrix(false, true);
  }
  updateMatrixWorld(_force = false) {
    this.updateWorldMatrix(false, true);
  }
  worldToLocal(vector: Vector3) {
    return vector.applyMatrix4(this.matrixWorld.clone().invert());
  }
}
export class Group extends Object3D {
  override readonly type: string = "Group";
}
export class Scene extends Object3D {
  override readonly type: string = "Scene";
  /** Strength of the built-in studio room reflected by physical materials; 0 disables it. */
  environment = 0;
}
export class Mesh extends Object3D {
  override readonly type: string = "Mesh";
  geometry: BufferGeometry;
  material: Material;
  constructor(geometry = new BufferGeometry(), material: Material = new MeshBasicMaterial()) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}
export class AmbientLight extends Object3D {
  readonly color: Color;
  intensity: number;
  constructor(color = 0xffffff, intensity = 1) {
    super();
    this.color = new Color(color);
    this.intensity = intensity;
  }
}
export class DirectionalLight extends AmbientLight {}

export class PerspectiveCamera extends Object3D {
  readonly projectionMatrix = new Matrix4();
  matrixWorldInverse = new Matrix4();
  fov: number;
  aspect: number;
  near: number;
  far: number;
  constructor(fov = 50, aspect = 1, near = 0.1, far = 2000) {
    super();
    [this.fov, this.aspect, this.near, this.far] = [fov, aspect, near, far];
    this.updateProjectionMatrix();
  }
  updateProjectionMatrix() {
    this.projectionMatrix.makePerspective(this.fov, this.aspect, this.near, this.far);
  }
  override updateWorldMatrix(updateParents: boolean, updateChildren: boolean) {
    super.updateWorldMatrix(updateParents, updateChildren);
    this.matrixWorldInverse = this.matrixWorld.clone().invert();
  }
  lookAt(x: number, y: number, z: number) {
    this.updateWorldMatrix(true, false);
    const eye = new Vector3().setFromMatrixPosition(this.matrixWorld);
    this.quaternion.setFromRotationMatrix(new Matrix4().lookAt(eye, new Vector3(x, y, z), new Vector3(0, 1, 0)));
  }
  clone() {
    const camera = new PerspectiveCamera(this.fov, this.aspect, this.near, this.far);
    camera.position.copy(this.position);
    camera.quaternion.copy(this.quaternion);
    camera.updateWorldMatrix(false, false);
    return camera;
  }
}

export type Intersection = {
  distance: number;
  point: Vector3;
  uv: Vector2 | undefined;
  face: { a: number; b: number; c: number };
  object: Object3D;
};

export class Raycaster {
  readonly ray = new Ray();
  setFromCamera(coords: Vector2, camera: PerspectiveCamera) {
    this.ray.origin.setFromMatrixPosition(camera.matrixWorld);
    const projectionInverse = camera.projectionMatrix.clone().invert();
    this.ray.direction
      .set(coords.x, coords.y, 0.5)
      .applyMatrix4(projectionInverse)
      .applyMatrix4(camera.matrixWorld)
      .sub(this.ray.origin)
      .normalize();
  }
  intersectObject(object: Object3D, recursive = true) {
    return this.intersectObjects([object], recursive);
  }
  intersectObjects(objects: readonly Object3D[], recursive = true) {
    const hits: Intersection[] = [];
    const visit = (object: Object3D) => {
      if (object instanceof Mesh) this.intersectMesh(object, hits);
      if (recursive) for (const child of object.children) visit(child);
    };
    for (const object of objects) visit(object);
    return hits.sort((a, b) => a.distance - b.distance);
  }
  private intersectMesh(mesh: Mesh, hits: Intersection[]) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (!position) return;
    const local = this.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    geometry.boundingBox ?? geometry.computeBoundingBox();
    if (!rayHitsBox(local, geometry.boundingBox!)) return;
    const uv = geometry.attributes.uv;
    const culled = mesh.material.side === FrontSide;
    const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
    const [e1, e2, p, q, s] = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    forEachTriangle(geometry, (i0, i1, i2) => {
      a.fromBufferAttribute(position, i0);
      b.fromBufferAttribute(position, i1);
      c.fromBufferAttribute(position, i2);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      p.copy(local.direction).cross(e2);
      const det = e1.dot(p);
      if (Math.abs(det) < 1e-12 || (culled && det < 0)) return;
      s.subVectors(local.origin, a);
      const u = s.dot(p) / det;
      if (u < 0 || u > 1) return;
      q.copy(s).cross(e1);
      const v = local.direction.dot(q) / det;
      if (v < 0 || u + v > 1) return;
      const t = e2.dot(q) / det;
      if (t < 0) return;
      const point = local.at(t).applyMatrix4(mesh.matrixWorld);
      hits.push({
        distance: point.distanceTo(this.ray.origin),
        point,
        uv: uv
          ? new Vector2()
              .addScaledVector(new Vector2().fromBufferAttribute(uv, i0), 1 - u - v)
              .addScaledVector(new Vector2().fromBufferAttribute(uv, i1), u)
              .addScaledVector(new Vector2().fromBufferAttribute(uv, i2), v)
          : undefined,
        face: { a: i0, b: i1, c: i2 },
        object: mesh,
      });
    });
  }
}

function rayHitsBox(ray: Ray, box: Box3) {
  let near = 0;
  let far = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const inverse = 1 / ray.direction[axis];
    let t0 = (box.min[axis] - ray.origin[axis]) * inverse;
    let t1 = (box.max[axis] - ray.origin[axis]) * inverse;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, Number.isNaN(t0) ? -Infinity : t0);
    far = Math.min(far, Number.isNaN(t1) ? Infinity : t1);
    if (near > far + 1e-9) return false;
  }
  return true;
}

const VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv;
layout(location=3) in vec4 color;
uniform mat4 model, viewProjection;
uniform mat3 normalMatrix;
out vec3 vWorld; out vec3 vNormal; out vec2 vUv; out vec4 vColor;
void main() {
  vec4 world = model * vec4(position, 1.0);
  vWorld = world.xyz; vNormal = normalMatrix * normal; vUv = uv; vColor = color;
  gl_Position = viewProjection * world;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec2 vUv; in vec4 vColor;
out vec4 outColor;
uniform bool unlit, flipBack, vertexColors;
uniform vec4 baseColor;
uniform vec3 emissive, cameraPosition, ambient;
uniform float metalness, roughness, clearcoat, clearcoatRoughness, alphaTest, environment;
uniform vec2 normalScale;
uniform int maps;
uniform sampler2D baseMap, metalRoughMap, normalMap, emissiveMap, aoMap;
uniform int lightCount;
uniform vec3 lightDirection[4], lightColor[4];
const float PI = 3.141592653589793;

// A studio room: dim floor, bright walls and two softboxes, blurred by roughness.
vec3 room(vec3 d, float r) {
  float spread = 0.08 + r * 0.9;
  vec3 base = mix(vec3(0.18), vec3(0.85), smoothstep(-0.6, 0.8, d.y));
  float key = pow(max(dot(d, normalize(vec3(-0.5, 0.7, 0.5))), 0.0), 1.0 / (spread * spread * 0.05 + 0.002) * 0.02);
  float fill = pow(max(dot(d, normalize(vec3(0.6, 0.3, -0.5))), 0.0), 1.0 / (spread * spread * 0.05 + 0.002) * 0.02);
  return base + vec3(4.0) * key * (1.0 - r * 0.7) + vec3(2.0) * fill * (1.0 - r * 0.7);
}
float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float smith(float nv, float nl, float a) {
  float a2 = a * a;
  return 0.5 / max(nl * sqrt(nv * nv * (1.0 - a2) + a2) + nv * sqrt(nl * nl * (1.0 - a2) + a2), 1e-5);
}
vec3 schlick(vec3 f0, float vh) { return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); }
vec2 envBrdf(float nv, float r) {
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 k = r * c0 + c1;
  float a = min(k.x * k.x, exp2(-9.28 * nv)) * k.x + k.y;
  return vec2(-1.04, 1.04) * a + k.zw;
}
vec3 perturb(vec3 n, vec3 p, vec2 uv, vec3 m) {
  vec3 q0 = dFdx(p), q1 = dFdy(p); vec2 s0 = dFdx(uv), s1 = dFdy(uv);
  vec3 q1p = cross(q1, n), q0p = cross(n, q0);
  vec3 t = q1p * s0.x + q0p * s1.x, b = q1p * s0.y + q0p * s1.y;
  float scale = inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
  return normalize(mat3(t * scale, b * scale, n) * m);
}
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec4 albedo = baseColor;
  if ((maps & 1) != 0) albedo *= texture(baseMap, vUv);
  if (vertexColors) albedo *= vColor;
  if (albedo.a < alphaTest) discard;
  if (unlit) { outColor = vec4(toSrgb(albedo.rgb) * albedo.a, albedo.a); return; }
  vec3 n = normalize(vNormal);
  if (flipBack && !gl_FrontFacing) n = -n;
  vec3 geometric = n;
  if ((maps & 4) != 0) n = perturb(n, vWorld, vUv, (texture(normalMap, vUv).xyz * 2.0 - 1.0) * vec3(normalScale, 1.0));
  float metal = metalness, rough = roughness;
  if ((maps & 2) != 0) { vec4 mr = texture(metalRoughMap, vUv); rough *= mr.g; metal *= mr.b; }
  rough = clamp(rough, 0.045, 1.0);
  float a = rough * rough;
  vec3 v = normalize(cameraPosition - vWorld);
  float nv = clamp(abs(dot(n, v)), 1e-4, 1.0);
  vec3 diffuse = albedo.rgb * (1.0 - metal);
  vec3 f0 = mix(vec3(0.04), albedo.rgb, metal);
  vec3 light = diffuse * ambient / PI;
  float coatNv = clamp(dot(geometric, v), 1e-4, 1.0);
  float coatA = max(clearcoatRoughness, 0.045); coatA *= coatA;
  vec3 coat = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= lightCount) break;
    vec3 l = lightDirection[i];
    vec3 h = normalize(l + v);
    float nl = clamp(dot(n, l), 0.0, 1.0);
    vec3 irradiance = lightColor[i] * nl;
    float vh = clamp(dot(v, h), 0.0, 1.0);
    light += irradiance * (diffuse / PI + schlick(f0, vh) * smith(nv, nl, a) * ggx(clamp(dot(n, h), 0.0, 1.0), a));
    if (clearcoat > 0.0) {
      float cl = clamp(dot(geometric, l), 0.0, 1.0);
      coat += lightColor[i] * cl * schlick(vec3(0.04), vh) * smith(coatNv, cl, coatA) * ggx(clamp(dot(geometric, h), 0.0, 1.0), coatA);
    }
  }
  if (environment > 0.0) {
    vec2 ab = envBrdf(nv, rough);
    light += environment * (room(n, 1.0) * diffuse + room(reflect(-v, n), rough) * (f0 * ab.x + ab.y));
    if (clearcoat > 0.0) {
      vec2 cab = envBrdf(coatNv, clearcoatRoughness);
      coat += environment * room(reflect(-v, geometric), clearcoatRoughness) * (0.04 * cab.x + cab.y);
    }
  }
  if ((maps & 16) != 0) light *= texture(aoMap, vUv).r;
  float coatFresnel = clearcoat * schlick(vec3(0.04), coatNv).x;
  light = light * (1.0 - coatFresnel) + clearcoat * coat;
  vec3 glow = emissive;
  if ((maps & 8) != 0) glow *= texture(emissiveMap, vUv).rgb;
  outColor = vec4(toSrgb(light + glow) * albedo.a, albedo.a);
}`;

type GpuGeometry = { vao: WebGLVertexArrayObject; buffers: Map<string, { attribute: BufferAttribute; buffer: WebGLBuffer; version: number }>; index: { attribute: BufferAttribute; buffer: WebGLBuffer; version: number } | null; count: number };
type GpuTexture = { texture: WebGLTexture; version: number };

export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly geometries = new Map<BufferGeometry, GpuGeometry>();
  private readonly textures = new Map<Texture, GpuTexture>();
  private disposed = false;
  constructor(options: { canvas: HTMLCanvasElement; alpha?: boolean; antialias?: boolean; powerPreference?: WebGLPowerPreference }) {
    const gl = options.canvas.getContext("webgl2", {
      alpha: options.alpha ?? false,
      antialias: options.antialias ?? false,
      premultipliedAlpha: true,
      powerPreference: options.powerPreference ?? "default",
    });
    if (!gl) throw new Error("WebGL2 is unavailable");
    this.gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost())
        throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compilation failed");
      return shader;
    };
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error(gl.getProgramInfoLog(this.program) ?? "Shader link failed");
    gl.useProgram(this.program);
    ["baseMap", "metalRoughMap", "normalMap", "emissiveMap", "aoMap"].forEach((name, unit) => gl.uniform1i(this.uniform(name), unit));
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
  }
  private uniform(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }
  setDrawingBufferSize(width: number, height: number, pixelRatio: number) {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    this.gl.viewport(0, 0, canvas.width, canvas.height);
  }
  render(scene: Scene, camera: PerspectiveCamera) {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) return;
    scene.updateMatrixWorld(true);
    if (!camera.parent) camera.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    const ambient = [0, 0, 0];
    const directions: number[] = [];
    const colors: number[] = [];
    const visit = (object: Object3D) => {
      if (!object.visible) return;
      if (object instanceof Mesh) meshes.push(object);
      else if (object instanceof DirectionalLight) {
        if (directions.length < 12) {
          directions.push(...new Vector3().setFromMatrixPosition(object.matrixWorld).normalize().toArray());
          colors.push(object.color.r * object.intensity, object.color.g * object.intensity, object.color.b * object.intensity);
        }
      } else if (object instanceof AmbientLight) {
        ambient[0]! += object.color.r * object.intensity;
        ambient[1]! += object.color.g * object.intensity;
        ambient[2]! += object.color.b * object.intensity;
      }
      for (const child of object.children) visit(child);
    };
    visit(scene);
    gl.useProgram(this.program);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    gl.uniformMatrix4fv(this.uniform("viewProjection"), false, viewProjection.elements);
    gl.uniform3f(this.uniform("cameraPosition"), ...(new Vector3().setFromMatrixPosition(camera.matrixWorld).toArray() as [number, number, number]));
    gl.uniform3fv(this.uniform("ambient"), ambient);
    gl.uniform1i(this.uniform("lightCount"), directions.length / 3);
    if (directions.length) {
      gl.uniform3fv(this.uniform("lightDirection"), directions);
      gl.uniform3fv(this.uniform("lightColor"), colors);
    }
    gl.uniform1f(this.uniform("environment"), scene.environment);
    const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const depth = (mesh: Mesh) => new Vector3().setFromMatrixPosition(mesh.matrixWorld).distanceTo(eye);
    const opaque = meshes.filter((mesh) => !mesh.material.transparent);
    const blended = meshes.filter((mesh) => mesh.material.transparent).sort((a, b) => depth(b) - depth(a));
    gl.disable(gl.BLEND);
    for (const mesh of opaque) this.draw(mesh);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const mesh of blended) this.draw(mesh);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
  }
  private draw(mesh: Mesh) {
    const gl = this.gl;
    const { material } = mesh;
    const gpu = this.geometry(mesh.geometry);
    if (!gpu.count) return;
    gl.uniformMatrix4fv(this.uniform("model"), false, mesh.matrixWorld.elements);
    const n = mesh.matrixWorld.clone().invert().elements;
    gl.uniformMatrix3fv(this.uniform("normalMatrix"), false, [n[0]!, n[4]!, n[8]!, n[1]!, n[5]!, n[9]!, n[2]!, n[6]!, n[10]!]);
    gl.uniform1i(this.uniform("unlit"), material.unlit ? 1 : 0);
    gl.uniform1i(this.uniform("vertexColors"), material.vertexColors ? 1 : 0);
    gl.uniform1i(this.uniform("flipBack"), material.side === DoubleSide ? 1 : 0);
    if (material.side === DoubleSide) gl.disable(gl.CULL_FACE);
    else gl.enable(gl.CULL_FACE);
    gl.uniform4f(this.uniform("baseColor"), material.color.r, material.color.g, material.color.b, material.opacity);
    gl.uniform1f(this.uniform("alphaTest"), material.alphaTest);
    let maps = 0;
    const bind = (texture: Texture | null, unit: number) => {
      if (!texture?.image) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(texture));
      maps |= 1 << unit;
    };
    bind(material.map, 0);
    if (material instanceof MeshStandardMaterial) {
      bind(material.metalnessMap, 1);
      bind(material.normalMap, 2);
      bind(material.emissiveMap, 3);
      bind(material.aoMap, 4);
      gl.uniform1f(this.uniform("metalness"), material.metalness);
      gl.uniform1f(this.uniform("roughness"), material.roughness);
      gl.uniform1f(this.uniform("clearcoat"), material.clearcoat);
      gl.uniform1f(this.uniform("clearcoatRoughness"), material.clearcoatRoughness);
      gl.uniform2f(this.uniform("normalScale"), material.normalScale.x, material.normalScale.y);
      gl.uniform3f(this.uniform("emissive"), material.emissive.r, material.emissive.g, material.emissive.b);
    }
    gl.uniform1i(this.uniform("maps"), maps);
    gl.colorMask(material.colorWrite, material.colorWrite, material.colorWrite, material.colorWrite);
    gl.depthMask(material.depthWrite);
    gl.bindVertexArray(gpu.vao);
    if (gpu.index) gl.drawElements(gl.TRIANGLES, gpu.count, gpu.index.attribute.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, gpu.count);
    gl.bindVertexArray(null);
  }
  private geometry(geometry: BufferGeometry) {
    const gl = this.gl;
    let gpu = this.geometries.get(geometry);
    if (!gpu) {
      const created: GpuGeometry = { vao: gl.createVertexArray()!, buffers: new Map(), index: null, count: 0 };
      gpu = created;
      this.geometries.set(geometry, created);
      geometry.disposeListeners.add(() => {
        gl.deleteVertexArray(created.vao);
        for (const { buffer } of created.buffers.values()) gl.deleteBuffer(buffer);
        if (created.index) gl.deleteBuffer(created.index.buffer);
        this.geometries.delete(geometry);
      });
    }
    gl.bindVertexArray(gpu.vao);
    const upload = (target: number, entry: { attribute: BufferAttribute; buffer: WebGLBuffer; version: number }) => {
      gl.bindBuffer(target, entry.buffer);
      if (entry.version === entry.attribute.version) return;
      gl.bufferData(target, entry.attribute.array, gl.DYNAMIC_DRAW);
      entry.version = entry.attribute.version;
    };
    for (const [name, location] of [["position", 0], ["normal", 1], ["uv", 2], ["color", 3]] as const) {
      const attribute = geometry.attributes[name];
      let entry = gpu.buffers.get(name);
      if (entry && entry.attribute !== attribute) {
        gl.deleteBuffer(entry.buffer);
        gpu.buffers.delete(name);
        entry = undefined;
      }
      if (!attribute) {
        gl.disableVertexAttribArray(location);
        continue;
      }
      if (!entry) gpu.buffers.set(name, (entry = { attribute, buffer: gl.createBuffer()!, version: -1 }));
      upload(gl.ARRAY_BUFFER, entry);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, attribute.itemSize, glType(gl, attribute.array), attribute.normalized, 0, 0);
    }
    gl.vertexAttrib4f(3, 1, 1, 1, 1);
    if (geometry.index) {
      if (gpu.index?.attribute !== geometry.index) {
        if (gpu.index) gl.deleteBuffer(gpu.index.buffer);
        gpu.index = { attribute: geometry.index, buffer: gl.createBuffer()!, version: -1 };
      }
      upload(gl.ELEMENT_ARRAY_BUFFER, gpu.index);
    }
    gpu.count = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
    gl.bindVertexArray(null);
    return gpu;
  }
  private texture(texture: Texture) {
    const gl = this.gl;
    let gpu = this.textures.get(texture);
    if (!gpu) {
      const created: GpuTexture = { texture: gl.createTexture()!, version: -1 };
      gpu = created;
      this.textures.set(texture, created);
      texture.disposeListeners.add(() => {
        gl.deleteTexture(created.texture);
        this.textures.delete(texture);
      });
    }
    gl.bindTexture(gl.TEXTURE_2D, gpu.texture);
    if (gpu.version !== texture.version && texture.image) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      const srgb = texture.colorSpace === "srgb";
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, texture.image);
      const wrap = texture.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (texture.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, texture.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gpu.version = texture.version;
    }
    return gpu.texture;
  }
  dispose() {
    for (const geometry of [...this.geometries.keys()]) geometry.disposeListeners.forEach((listener) => listener());
    for (const texture of [...this.textures.keys()]) texture.disposeListeners.forEach((listener) => listener());
    this.gl.deleteProgram(this.program);
    this.disposed = true;
  }
  forceContextLoss() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function glType(gl: WebGL2RenderingContext, array: AttributeArray) {
  if (array instanceof Float32Array) return gl.FLOAT;
  if (array instanceof Uint8Array) return gl.UNSIGNED_BYTE;
  if (array instanceof Uint16Array) return gl.UNSIGNED_SHORT;
  if (array instanceof Int8Array) return gl.BYTE;
  if (array instanceof Int16Array) return gl.SHORT;
  return gl.UNSIGNED_INT;
}

/** Releases every geometry, material and texture under `root`, closing decoded images. */
export function disposeObject(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    materials.add(object.material);
  });
  const textures = new Set([...materials].flatMap((material) => material.textures()));
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) images.add(texture.image);
  }
  for (const image of images) image.close();
}

type Gltf = {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
  textures?: { source?: number; sampler?: number; extensions?: Record<string, { source?: number }> }[];
  samplers?: { wrapS?: number; minFilter?: number }[];
  materials?: {
    name?: string;
    doubleSided?: boolean;
    alphaMode?: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff?: number;
    emissiveFactor?: number[];
    normalTexture?: { index: number; scale?: number };
    occlusionTexture?: { index: number };
    emissiveTexture?: { index: number };
    pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } };
    extensions?: { KHR_materials_clearcoat?: { clearcoatFactor?: number; clearcoatRoughnessFactor?: number } };
  }[];
};

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>;
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array } as const;
const ATTRIBUTES: Record<string, string> = { POSITION: "position", NORMAL: "normal", TEXCOORD_0: "uv", TEXCOORD_1: "uv1", COLOR_0: "color" };

/** Reads a binary glTF 2.0 file: uncompressed triangle meshes, PBR materials and embedded images. */
export async function parseGlb(data: ArrayBuffer): Promise<Group> {
  const view = new DataView(data);
  if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2)
    throw new Error("Not a glTF 2.0 binary file");
  let json: Gltf | undefined;
  let bin = new Uint8Array();
  for (let offset = 12; offset + 8 <= data.byteLength; ) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const chunk = new Uint8Array(data, offset + 8, length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error("glTF file has no JSON chunk");
  const gltf = json;
  const viewBytes = (index: number) => {
    const bufferView = gltf.bufferViews![index]!;
    return bin.subarray(bufferView.byteOffset ?? 0, (bufferView.byteOffset ?? 0) + bufferView.byteLength);
  };
  const accessor = (index: number) => {
    const meta = gltf.accessors![index]!;
    const Type = ARRAYS[meta.componentType as keyof typeof ARRAYS];
    const size = COMPONENTS[meta.type]!;
    const out = new Type(meta.count * size);
    if (meta.bufferView === undefined) return { array: out, size, normalized: !!meta.normalized };
    const bufferView = gltf.bufferViews![meta.bufferView]!;
    const bytes = viewBytes(meta.bufferView);
    const element = size * Type.BYTES_PER_ELEMENT;
    const stride = bufferView.byteStride || element;
    const source = new Uint8Array(out.buffer);
    for (let i = 0; i < meta.count; i++)
      source.set(bytes.subarray((meta.byteOffset ?? 0) + i * stride, (meta.byteOffset ?? 0) + i * stride + element), i * element);
    return { array: out, size, normalized: !!meta.normalized };
  };
  const images = await Promise.all(
    (gltf.images ?? []).map((image) =>
      image.bufferView === undefined
        ? null
        : createImageBitmap(new Blob([viewBytes(image.bufferView)], { type: image.mimeType ?? "image/png" }), {
            premultiplyAlpha: "none",
            colorSpaceConversion: "none",
          }),
    ),
  );
  const textureCache = new Map<string, Texture>();
  const texture = (index: number | undefined, srgb: boolean) => {
    if (index === undefined) return null;
    const key = `${index}:${srgb}`;
    const cached = textureCache.get(key);
    if (cached) return cached;
    const definition = gltf.textures![index]!;
    const source = definition.extensions?.EXT_texture_webp?.source ?? definition.source;
    const image = source === undefined ? null : images[source];
    if (!image) return null;
    const sampler = definition.sampler === undefined ? undefined : gltf.samplers?.[definition.sampler];
    const result = new Texture(image);
    result.flipY = false;
    result.colorSpace = srgb ? "srgb" : "linear";
    result.repeat = (sampler?.wrapS ?? 10497) === 10497;
    result.mipmaps = (sampler?.minFilter ?? 9987) >= 9984;
    result.version = 1;
    textureCache.set(key, result);
    return result;
  };
  const materials = (gltf.materials ?? []).map((definition) => {
    const clearcoat = definition.extensions?.KHR_materials_clearcoat;
    const material = clearcoat ? new MeshPhysicalMaterial() : new MeshStandardMaterial();
    const pbr = definition.pbrMetallicRoughness ?? {};
    const [r, g, b, a] = pbr.baseColorFactor ?? [1, 1, 1, 1];
    material.name = definition.name ?? "";
    material.color.setRGB(r!, g!, b!);
    material.opacity = a!;
    material.metalness = pbr.metallicFactor ?? 1;
    material.roughness = pbr.roughnessFactor ?? 1;
    material.map = texture(pbr.baseColorTexture?.index, true);
    material.metalnessMap = texture(pbr.metallicRoughnessTexture?.index, false);
    material.normalMap = texture(definition.normalTexture?.index, false);
    const scale = definition.normalTexture?.scale ?? 1;
    // Derivative tangents with glTF's top-left UV origin flip the bitangent.
    material.normalScale.set(scale, -scale);
    material.emissiveMap = texture(definition.emissiveTexture?.index, true);
    material.aoMap = texture(definition.occlusionTexture?.index, false);
    const [er, eg, eb] = definition.emissiveFactor ?? [0, 0, 0];
    material.emissive.setRGB(er!, eg!, eb!);
    material.side = definition.doubleSided ? DoubleSide : FrontSide;
    material.transparent = definition.alphaMode === "BLEND";
    material.alphaTest = definition.alphaMode === "MASK" ? (definition.alphaCutoff ?? 0.5) : 0;
    if (clearcoat) {
      material.clearcoat = clearcoat.clearcoatFactor ?? 0;
      material.clearcoatRoughness = clearcoat.clearcoatRoughnessFactor ?? 0;
    }
    return material;
  });
  const primitive = (definition: NonNullable<Gltf["meshes"]>[number]["primitives"][number]) => {
    if ((definition.mode ?? 4) !== 4) return null;
    const geometry = new BufferGeometry();
    for (const [semantic, index] of Object.entries(definition.attributes)) {
      const name = ATTRIBUTES[semantic];
      if (!name) continue;
      const { array, size, normalized } = accessor(index);
      geometry.setAttribute(name, new BufferAttribute(array, size, normalized));
    }
    if (definition.indices !== undefined) {
      const { array } = accessor(definition.indices);
      geometry.setIndex(new BufferAttribute(array instanceof Uint8Array ? new Uint16Array(array) : array, 1));
    }
    if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
    const material = definition.material === undefined ? new MeshStandardMaterial() : materials[definition.material]!;
    // An absent color attribute reads as opaque white, so a shared material can always multiply it.
    if (geometry.hasAttribute("color")) material.vertexColors = true;
    return new Mesh(geometry, material);
  };
  const node = (index: number): Object3D => {
    const definition = gltf.nodes![index]!;
    const primitives = definition.mesh === undefined ? [] : gltf.meshes![definition.mesh]!.primitives.map(primitive).filter((m): m is Mesh => !!m);
    const object: Object3D = primitives.length === 1 ? primitives[0]! : new Group();
    if (primitives.length > 1) object.add(...primitives);
    object.name = definition.name ?? "";
    if (definition.matrix) {
      const matrix = new Matrix4().fromArray(definition.matrix);
      const e = matrix.elements;
      const scale = new Vector3(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!), Math.hypot(e[8]!, e[9]!, e[10]!));
      object.position.setFromMatrixPosition(matrix);
      object.quaternion.setFromRotationMatrix(new Matrix4().extractRotation(matrix));
      object.scale.copy(scale);
    }
    if (definition.translation) object.position.set(...(definition.translation as [number, number, number]));
    if (definition.rotation) object.quaternion.set(...(definition.rotation as [number, number, number, number]));
    if (definition.scale) object.scale.set(...(definition.scale as [number, number, number]));
    for (const child of definition.children ?? []) object.add(node(child));
    return object;
  };
  const scene = new Group();
  for (const index of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) scene.add(node(index));
  return scene;
}
