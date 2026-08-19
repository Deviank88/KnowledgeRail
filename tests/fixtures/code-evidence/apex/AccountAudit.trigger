trigger AccountAudit on Account (before insert, after update) {
  AuditService.record(Trigger.new);
}
