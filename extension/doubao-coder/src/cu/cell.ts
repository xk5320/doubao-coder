/**
 * Cell 记账移植（对照 `gac_runtime/cell.py` 的 `CellExecutor`）
 *
 * 职责：一次"动作批"的记账 —— 动作、观察、图像、截断计数，
 * 以及几条**必须在 TS 里保持一致**的规则：
 *   - 图像超限淘汰时，**级联删除**引用它的观察（cell.py:189-196）
 *   - 观察的 superseded 由 `after < actions_total` 反推（cell.py:230-235）
 *   - `type` 参数**不记录原文**，只记 `chars=<len>`（_instrumentation.py:46-49）
 *   - hotkey 只记前 8 个键；其余参数最多 4 个值、字符串截 80
 */
import type { GacProfile } from './profile';
import { DEFAULT_PROFILE } from './profile';
import type { CellAction, CellEnvelope, CellExc, CellObservation } from './envelope';

/** 参数脱敏（`_instrumentation.py:36-60`）。 */
export function sanitizeArgs(op: string, args: unknown[]): unknown[] {
  if (op === 'type' || op === 'type_text' || op === 'select_text') {
    const text = typeof args[0] === 'string' ? args[0] : '';
    return [`chars=${text.length}`];
  }
  if (op === 'hotkey') {
    return args.slice(0, 8).map((v) => String(v));
  }
  return args.slice(0, 4).map((v) => {
    if (typeof v === 'number' || typeof v === 'boolean') {
      return v;
    }
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 80)}...` : s;
  });
}

export class CellExecutor {
  public actions: CellAction[] = [];
  public observations: CellObservation[] = [];
  public images: Array<{ path: string; tag?: string; w: number; h: number; mime_type: string }> = [];
  public actionsTotal = 0;
  public actionsPossible = 0;
  public actionsDropped = 0;
  public observationsDropped = 0;
  public imagesDropped = 0;
  private imageNumber = 0;
  private readonly startedAt = Date.now();
  /** 每条观察创建时的 actions_total，用于判定 superseded。 */
  private readonly obsAfter = new Map<CellObservation, number>();

  constructor(private readonly profile: GacProfile = DEFAULT_PROFILE) {}

  /** 记录一次"尝试"（进入即 attempted）。 */
  public record(lib: string, op: string, args: unknown[]): CellAction {
    const action: CellAction = {
      lib,
      op,
      args: sanitizeArgs(op, args),
      t_ms: Date.now() - this.startedAt,
      state: 'attempted',
    };
    this.actions.push(action);
    this.actionsPossible += 1;
    if (this.actions.length > this.profile.max_actions) {
      const drop = this.actions.length - this.profile.max_actions;
      this.actions.splice(0, drop);
      this.actionsDropped += drop;
    }
    return action;
  }

  /** 成功 / 失败收尾，维护 confirmed/possible 计数。 */
  public settle(action: CellAction, ok: boolean): void {
    action.state = ok ? 'completed' : 'rejected';
    this.actionsPossible = Math.max(0, this.actionsPossible - 1);
    if (ok) {
      this.actionsTotal += 1;
    }
  }

  public addText(scope: string, body: string): CellObservation {
    let text = body;
    let clipped = 0;
    if (text.length > this.profile.max_observation_chars) {
      clipped = text.length - this.profile.max_observation_chars;
      text = text.slice(0, this.profile.max_observation_chars);
    }
    const obs: CellObservation = {
      kind: 'dom',
      scope,
      superseded: false,
      text,
      ...(clipped > 0 ? { clipped } : {}),
    };
    this.pushObservation(obs);
    return obs;
  }

  /** 图像观察；path 由调用方落盘后给出。 */
  public addImage(path: string, width: number, height: number, tag?: string): CellObservation {
    this.imageNumber += 1;
    const entry = { path, tag: tag ?? `shot${this.imageNumber}`, w: width, h: height, mime_type: 'image/png' };
    this.images.push(entry);
    const obs: CellObservation = {
      kind: 'image',
      scope: 'screen',
      superseded: false,
      path,
      tag: entry.tag,
      width,
      height,
      mime_type: 'image/png',
    };
    this.pushObservation(obs);
    return obs;
  }

  private pushObservation(obs: CellObservation): void {
    this.observations.push(obs);
    this.obsAfter.set(obs, this.actionsTotal);
    if (this.observations.length > this.profile.max_observations) {
      const drop = this.observations.length - this.profile.max_observations;
      this.observations.splice(0, drop);
      this.observationsDropped += drop;
    }
    if (this.images.length > this.profile.max_images) {
      const dropCount = this.images.length - this.profile.max_images;
      const removed = this.images.splice(0, dropCount);
      this.imagesDropped += dropCount;
      // 级联删除引用被淘汰图像的观察
      const removedPaths = new Set(removed.map((img) => img.path));
      const before = this.observations.length;
      this.observations = this.observations.filter((o) => !(o.kind === 'image' && o.path && removedPaths.has(o.path)));
      this.observationsDropped += before - this.observations.length;
    }
  }

  /** 生成可渲染的 envelope。 */
  public toEnvelope(extra: { ok: boolean; exc?: CellExc | null; timedOut?: boolean; stdout?: string; stderr?: string }): CellEnvelope {
    const truncated: Record<string, number> = {};
    if (this.actionsDropped) {
      truncated.actions = this.actionsDropped;
    }
    if (this.observationsDropped) {
      truncated.observations = this.observationsDropped;
    }
    if (this.imagesDropped) {
      truncated.images = this.imagesDropped;
    }
    const observations = this.observations.map((obs) => ({
      ...obs,
      // 观察创建后又有动作完成（after < actions_total）→ 该观察过期
      superseded: obs.superseded || (this.obsAfter.get(obs) ?? 0) < this.actionsTotal,
    }));
    return {
      v: 1,
      ok: extra.ok,
      timed_out: Boolean(extra.timedOut),
      elapsed_ms: Date.now() - this.startedAt,
      stdout: extra.stdout ?? '',
      stderr: extra.stderr ?? '',
      exc: extra.exc ?? null,
      actions: this.actions,
      actions_total: this.actionsTotal,
      actions_possible: this.actionsPossible,
      observations,
      images: this.images,
      gac_profile: this.profile,
      ...(Object.keys(truncated).length ? { truncated } : {}),
      auto_observation: { attempted: false },
    };
  }
}
