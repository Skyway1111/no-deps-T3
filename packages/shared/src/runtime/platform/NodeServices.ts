import * as Layer from "../Layer.ts";
import * as NodeFileSystem from "./NodeFileSystem.ts";
import * as NodePath from "./NodePath.ts";
import * as NodeChildProcessSpawner from "./NodeChildProcessSpawner.ts";
import * as NodeStdio from "./NodeStdio.ts";
import * as NodeTerminal from "./NodeTerminal.ts";
import type { FileSystem } from "../FileSystem.ts";
import type { Path } from "../Path.ts";
import type { ChildProcessSpawner } from "../process/ChildProcessSpawner.ts";
import type { Stdio } from "../Stdio.ts";
import type { Terminal } from "../Terminal.ts";

export type NodeServices = FileSystem | Path | ChildProcessSpawner | Stdio | Terminal;
export const layer: Layer.Layer<NodeServices> = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeChildProcessSpawner.layer, NodeStdio.layer, NodeTerminal.layer);
