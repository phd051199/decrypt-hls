import { inflateRaw } from 'pako';
import wasmModule from './dha-release.wasm';

interface WasmImports {
	b52: (str: string) => string;
	ift: (data: Uint8Array) => string;
	location: Location;
}

interface WasmExports extends WebAssembly.Exports {
	memory: WebAssembly.Memory;
	__new: (size: number, id: number) => number;
	__pin: (ptr: number) => number;
	__unpin: (ptr: number) => void;
	transformBuff: (data: number, flag1: number, flag2: number, flag3: number, flag4: number) => number;
	b62u: (data: number, param: number, extra: number) => number;
	dezip: (data: number) => number;
	exports?: any;
	[key: string]: any;
}

interface Location {
	hostname: string;
}

class DHA {
	private currentLocation: Location | null = null;
	private currentWindow: { hn: string } | null = null;
	private wasmInstance: WebAssembly.Instance | null = null;
	private decoder: TextDecoder;
	private memory!: WebAssembly.Memory;
	private wasmExports!: WasmExports;
	private refCounts: Map<number, number>;
	private dataView!: DataView;

	constructor() {
		this.decoder = new TextDecoder();
		this.refCounts = new Map();
	}

	private async initializeWasm(wasmBinary: ArrayBuffer, options: { w?: Partial<WasmImports>; env?: any } = {}): Promise<WasmExports> {
		const wasmImports = options.w;
		const importObject = {
			w: Object.assign(Object.create(null), wasmImports, {
				b52: (ptr: number): number => {
					const str = this.getString(ptr >>> 0);
					if (!str) return 0;
					return this.allocateString(wasmImports?.b52?.(str) || '') || this.throwNullError();
				},
				ift: (ptr: number): number => {
					const offset = ptr >>> 0;
					if (!offset) return 0;
					const buffer = this.memory.buffer.slice(offset, offset + new Uint32Array(this.memory.buffer)[(offset - 4) >>> 2]);
					return this.allocateString(wasmImports?.ift?.(new Uint8Array(buffer)) || '') || this.throwNullError();
				},
			}),
			env: Object.assign(Object.create(globalThis), options.env || {}, {
				abort: (msgPtr: number, filePtr: number, line: number, col: number) => {
					const msg = this.getString(msgPtr >>> 0);
					const file = this.getString(filePtr >>> 0);
					line >>>= 0;
					col >>>= 0;
					throw new Error(`${msg} in ${file}:${line}:${col}`);
				},
			}),
		};

		const { exports: wasmExports } = await WebAssembly.instantiate(wasmBinary, importObject);
		this.memory = (wasmExports as WasmExports).memory || options.env?.memory;
		this.wasmExports = wasmExports as WasmExports;
		this.refCounts = new Map();
		this.dataView = new DataView(this.memory.buffer);

		return Object.setPrototypeOf(
			{
				transformBuff: (data: string, flag1: boolean, flag2: boolean, flag3: boolean, flag4: boolean): Uint8Array[] => {
					const ptr = this.allocateString(data) || this.throwNullError();
					const f1 = flag1 ? 1 : 0;
					const f2 = flag2 ? 1 : 0;
					const f3 = flag3 ? 1 : 0;
					const f4 = flag4 ? 1 : 0;
					const result = this.getArray(
						(p) => this.getTypedArray(Uint8Array, this.getPointer(p)),
						2,
						this.wasmExports.transformBuff(ptr, f1, f2, f3, f4) >>> 0,
					);
					return result || this.throwNullError();
				},

				b62u: (data: string, param: number, extra: string | null): Uint8Array[] => {
					const dataPtr = this.pinObject(this.allocateString(data) || this.throwNullError());
					const extraPtr = this.allocateString(extra);
					try {
						const result = this.getArray(
							(p) => this.getTypedArray(Uint8Array, this.getPointer(p)),
							2,
							this.wasmExports.b62u(dataPtr, param, extraPtr) >>> 0,
						);
						return result || this.throwNullError();
					} finally {
						this.unpinObject(dataPtr);
					}
				},

				dezip: (data: ArrayBuffer): string => {
					const ptr = this.allocateMemoryForData(data) || this.throwNullError();
					const result = this.getString(this.wasmExports.dezip(ptr) >>> 0);
					return result || this.throwNullError();
				},
			},
			wasmExports,
		);
	}

	private getString(ptr: number): string | null {
		if (!ptr) return null;
		const end = (ptr + new Uint32Array(this.memory.buffer)[(ptr - 4) >>> 2]) >>> 1;
		const view = new Uint16Array(this.memory.buffer);

		let offset = ptr >>> 1;
		let result = '';
		while (end - offset > 1024) {
			result += String.fromCharCode(...view.subarray(offset, (offset += 1024)));
		}
		return result + String.fromCharCode(...view.subarray(offset, end));
	}

	private allocateString(str: string | null): number {
		if (str == null) return 0;
		const len = str.length;
		const ptr = this.wasmExports.__new(len << 1, 2) >>> 0;
		const view = new Uint16Array(this.memory.buffer);
		for (let i = 0; i < len; ++i) {
			view[(ptr >>> 1) + i] = str.charCodeAt(i);
		}
		return ptr;
	}

	private getArray<T>(converter: (ptr: number) => T | null, shift: number, ptr: number): T[] | null {
		if (!ptr) return null;
		const base = this.getPointer(ptr + 4);
		const length = this.dataView.getUint32(ptr + 12, true);
		const result: T[] = [];
		for (let i = 0; i < length; ++i) {
			const item = converter(base + ((i << shift) >>> 0));
			if (item === null) return null;
			result.push(item);
		}
		return result;
	}

	private getTypedArray<T extends Uint8Array>(
		TypedArray: { new (buffer: ArrayBuffer, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number },
		ptr: number,
	): T | null {
		if (!ptr) return null;
		const array = new TypedArray(
			this.memory.buffer,
			this.getPointer(ptr + 4),
			this.dataView.getUint32(ptr + 8, true) / TypedArray.BYTES_PER_ELEMENT,
		);
		return array.slice() as T;
	}

	private throwNullError(): never {
		throw new TypeError('value must not be null');
	}

	private getPointer(ptr: number): number {
		try {
			return this.dataView.getUint32(ptr, true);
		} catch {
			this.dataView = new DataView(this.memory.buffer);
			return this.dataView.getUint32(ptr, true);
		}
	}

	private pinObject(ptr: number): number {
		if (ptr) {
			const count = this.refCounts.get(ptr);
			if (count) {
				this.refCounts.set(ptr, count + 1);
			} else {
				this.refCounts.set(this.wasmExports.__pin(ptr), 1);
			}
		}
		return ptr;
	}

	private unpinObject(ptr: number): void {
		if (ptr) {
			const count = this.refCounts.get(ptr);
			if (count === 1) {
				this.wasmExports.__unpin(ptr);
				this.refCounts.delete(ptr);
			} else if (count) {
				this.refCounts.set(ptr, count - 1);
			} else {
				throw new Error(`invalid refcount '${count}' for reference '${ptr}'`);
			}
		}
	}

	private allocateMemoryForData(data: ArrayBuffer | null): number {
		if (data == null) return 0;
		const ptr = this.wasmExports.__new(data.byteLength, 1) >>> 0;
		new Uint8Array(this.memory.buffer).set(new Uint8Array(data), ptr);
		return ptr;
	}

	public async decryptM3u8(
		data: string,
		flag1: boolean = true,
		flag2: boolean = false,
		flag3: boolean = false,
		flag4: boolean = false,
		extra: string | null = null,
	): Promise<string> {
		if (!this.wasmInstance) throw new Error('WASM not initialized');
		const hostBytes = (this.wasmInstance as any).b62u(
			this.shiftString(this.currentWindow?.hn ?? this.currentLocation!.hostname, 10),
			10,
			extra,
		);
		const digest = await crypto.subtle.digest(this.decoder.decode(hostBytes[0]), hostBytes[1]);
		const transformedData = (this.wasmInstance as any).transformBuff(data, flag1, flag2, flag3, flag4);
		const cryptoParams = { name: this.decoder.decode(transformedData[2]), iv: transformedData[0] };
		const key = await crypto.subtle.importKey('raw', digest, cryptoParams, false, [this.decoder.decode(transformedData[3])]);
		const decrypted = await crypto.subtle.decrypt(cryptoParams, key, transformedData[1]);
		return (this.wasmInstance as any).dezip(decrypted);
	}

	public async initialize(location: Location): Promise<void> {
		const wasmExports = await this.initializeWasm(wasmModule, {
			env: {},
			w: {
				location: (this.currentLocation = location),
				b52: (str: string) => atob(str),
				ift: (data: Uint8Array) => inflateRaw(data, { to: 'string' }),
			},
		});
		this.wasmInstance = {
			b62u: wasmExports.b62u,
			transformBuff: wasmExports.transformBuff,
			dezip: wasmExports.dezip,
			exports: wasmExports,
		} as WebAssembly.Instance;
	}

	private shiftString(str: string, shift: number): string {
		return str
			.split('')
			.map((char) => String.fromCharCode(char.charCodeAt(0) + shift))
			.join('');
	}
}

const dha = new DHA();
export const decryptM3u8 = dha.decryptM3u8.bind(dha);
export const init = dha.initialize.bind(dha);
