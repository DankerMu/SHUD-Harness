## 1. Server And Routing

- [ ] 1.1 Add Hono backend server entrypoint.
- [ ] 1.2 Add route registration structure.
- [ ] 1.3 Add workspace init route.
- [ ] 1.4 Add task create/list/read routes.

## 2. Validation And Error Handling

- [ ] 2.1 Validate task create input with core schemas.
- [ ] 2.2 Add canonical API error envelope helper.
- [ ] 2.3 Return schema errors through the envelope.
- [ ] 2.4 Return not-found errors through the envelope.

## 3. Idempotency

- [ ] 3.1 Add request digest calculation for mutating requests.
- [ ] 3.2 Add idempotency record persistence skeleton.
- [ ] 3.3 Return original response for repeated matching task create requests.
- [ ] 3.4 Return mismatch error for repeated key with different payload.

## 4. Tests

- [ ] 4.1 Add API integration test for workspace init.
- [ ] 4.2 Add API integration test for task create and persisted readback.
- [ ] 4.3 Add API integration test for task list.
- [ ] 4.4 Add negative test for invalid create request.
- [ ] 4.5 Add idempotency repeat and mismatch tests.
