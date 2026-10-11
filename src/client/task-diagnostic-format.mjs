const descriptions = {
  PLATFORM_QUOTA_HELD: '平台仍保留此任务的额度；诊断不会自动退还。',
  DISPATCH_ACK_PENDING: '原派发接收回执尚未确认；看到节点任务也不会自动重派。',
  NOT_DISPATCHED_FOR_READ: '尚未进入可查询的节点派发阶段。',
  NATIVE_NOT_OBSERVED: '本次没有观察到原节点任务，不等于从未启动。',
  NODE_READ_UNAVAILABLE: '节点查询暂不可用，训练状态不能据此改成失败。',
  NATIVE_WAIT_REASON_RECORDED: '原生调度器记录了等待原因，见状态 reason 字段。',
  NATIVE_WAIT_REASON_UNKNOWN: '原生任务仍排队，但没有记录具体等待原因；不能推断就是缺卡。',
  NATIVE_JOB_FAILED: '原生任务记录为失败，结合退出码与原轮次日志核对。',
  EXECUTION_UNCONFIRMED: '执行状态丢失或卡住，不能认定进程已退出。',
  ATTEMPT_NONZERO_EXIT: '本轮有非零退出码；不能单凭退出码认定 OOM。',
  CHECKPOINT_HANDOFF: '本轮处于保存／让位流程。',
  ATTEMPT_STOPPING: '本轮正在停止或清理，不能按完成释放资源。',
  PROGRESS_STALLED: '训练自报进度已标记停滞。',
  PROGRESS_REPORTED_PROBLEM: '进度上报有问题线索，不替代调度器终态。',
  ALLOCATION_GRANT_MISSING: '受管任务缺少原生额度许可。',
  ALLOCATION_GRANT_ID_MISMATCH: '原生额度许可编号与原派发不一致，需要核对。',
  INITIAL_GRANT_UNCONFIRMED: '原生初始许可未记录，不能把当前上限当作初始值。',
  INITIAL_GRANT_MISMATCH: '原生初始许可与平台初始派发卡数不一致，需要核对。',
  NO_LEGAL_GRANTED_GPU_COUNT: '当前许可覆盖不了任何合法卡数，不能启动或扩卡。',
  NATIVE_RESOURCE_RECORDS_PRESENT: '原生仍有 GPU 租约或扩容预留；这不是利用率读数。',
  NATIVE_RESOURCE_RECORDS_EMPTY: '原生暂未记录租约或预留；这不证明进程和数据租约已清理。',
  TERMINAL_WITH_RESOURCE_RECORDS: '任务虽记录为终态，仍有原生资源记录待核对。',
  OLDER_ATTEMPT_LEASES: '历史轮次仍有租约记录。',
  SCALE_UP_IN_PROGRESS: '原生扩卡计划尚未结束。',
  NATIVE_ACTIONS_PENDING: '原生仍有待执行动作。',
  NATIVE_ACTION_ERROR_RECORDED: '待执行动作曾记录错误；诊断不公开动作载荷或凭据。',
  EVIDENCE_TRUNCATED: '明细已截断；总数不是这页明细长度。',
};

/** Presentation only; the API owns facts and findings for every client. */
export function formatTaskDiagnostics(result) {
  const node = result.diagnostics.node, quota = result.quota;
  const lines = [`任务：${JSON.stringify(result.task.name)} / ${JSON.stringify(result.task.submitter.displayName)}`,
    `平台阶段：${result.task.stage}；节点观察：${node?.state ?? result.diagnostics.kind}`,
    `平台额度：${quota ? quota.state + ' / ' + quota.reservedGpuCount + ' 卡' : '无记录'}`];
  if (node) {
    lines.push(`原生记录：租约 ${node.resources.leases.total}；扩容预留 ${node.resources.reservations.total}`);
    if (node.reason) lines.push('调度原因：' + JSON.stringify(node.reason));
    if (node.latestAttempt) lines.push(`当前轮次：${JSON.stringify(node.latestAttempt.id)} / ${node.latestAttempt.state}；退出码：${node.latestAttempt.exitCode ?? '未知'}`);
    if (node.latestAttempt?.failureReason) lines.push('轮次原因：' + JSON.stringify(node.latestAttempt.failureReason));
  }
  lines.push(...result.findings.map(finding => `[${finding.level}] ${descriptions[finding.code]}`));
  lines.push('未采集：实时进程、当前节点容量、内核 OOM／PID 计数、worker 诊断、数据租约清理。');
  return lines;
}
