/**
 * 预算常量移植（对照 `gac_runtime/gac_profile.py:65-79`）
 * 原实现：一次 cell 选定，不可中途改；冲突抛 BU_GAC_PROFILE_CONFLICT。
 */
export interface GacProfile {
  max_stdout_chars: number;
  max_stderr_chars: number;
  max_actions: number;
  max_observations: number;
  max_observation_chars: number;
  max_images: number;
  stdout_render_limit: number;
  stderr_render_limit: number;
  error_render_limit: number;
  observation_render_limit: number;
  progress_ops_max: number;
  operation_label_limit: number;
}

export const DEFAULT_PROFILE: GacProfile = {
  max_stdout_chars: 200_000,
  max_stderr_chars: 40_000,
  max_actions: 400,
  max_observations: 64,
  max_observation_chars: 40_000,
  max_images: 8,
  stdout_render_limit: 16_000,
  stderr_render_limit: 2_000,
  error_render_limit: 4_800,
  observation_render_limit: 3_200,
  progress_ops_max: 5,
  operation_label_limit: 24,
};

export class ProfileConflictError extends Error {
  constructor() {
    super('GAC profile 已选定，不能中途修改');
    this.name = 'BU_GAC_PROFILE_CONFLICT';
  }
}

/** 一次性选定 profile（对齐 `GacProfileState.select`）。 */
export class ProfileState {
  private selected?: GacProfile;

  public select(profile: GacProfile = DEFAULT_PROFILE): GacProfile {
    if (this.selected) {
      throw new ProfileConflictError();
    }
    this.selected = profile;
    return profile;
  }

  public get current(): GacProfile {
    return this.selected ?? DEFAULT_PROFILE;
  }
}
