use super::*;

#[test]
fn handler_lists_only_goal_records_from_planning_storage() {
    let (_temp_dir, mut handler) = handler(None);
    let goal = fixture_record(
        PersistenceDomain::Planning,
        PersistenceRecordKind::Goal,
        "goal:one",
        "rev:goal:one",
    );
    let task_seed = fixture_record(
        PersistenceDomain::Planning,
        PersistenceRecordKind::TaskSeed,
        "seed:one",
        "rev:seed:one",
    );
    handler
        .state()
        .planning()
        .put(goal.clone(), RevisionExpectation::MustNotExist)
        .expect("goal");
    handler
        .state()
        .planning()
        .put(task_seed, RevisionExpectation::MustNotExist)
        .expect("task seed");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:goals".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:goals".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Goal(StateRecordQuery {
                domain: ServerStateDomain::Goals,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet { domain: ServerStateDomain::Goals, records }
        )) if records == vec![goal]
    ));
}
