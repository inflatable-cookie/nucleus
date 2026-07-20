use super::super::task_authoring::TaskAuthoringReceipt;

pub(super) fn consolidate_task_receipts(
    receipts: Vec<TaskAuthoringReceipt>,
) -> Vec<TaskAuthoringReceipt> {
    let created = receipts
        .iter()
        .flat_map(|receipt| receipt.created.clone())
        .collect::<Vec<_>>();
    let updated = receipts
        .iter()
        .flat_map(|receipt| receipt.updated.clone())
        .collect::<Vec<_>>();
    let goals_created = receipts
        .iter()
        .flat_map(|receipt| receipt.goals_created.clone())
        .collect::<Vec<_>>();
    let goals_updated = receipts
        .into_iter()
        .flat_map(|receipt| receipt.goals_updated)
        .collect::<Vec<_>>();
    if created.is_empty()
        && updated.is_empty()
        && goals_created.is_empty()
        && goals_updated.is_empty()
    {
        Vec::new()
    } else {
        vec![TaskAuthoringReceipt {
            created,
            updated,
            goals_created,
            goals_updated,
        }]
    }
}
