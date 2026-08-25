# Team invitations

Administrators may invite one email address at a time. Repeating an invitation while one is pending must be idempotent. Members cannot create invitations. An invitation expires seven days after creation. The existing signup route must remain available.

QA can use the demo-only role selector and reset endpoint. Production systems would obtain role identity from authentication and expose test state through isolated fixtures, never public endpoints.
