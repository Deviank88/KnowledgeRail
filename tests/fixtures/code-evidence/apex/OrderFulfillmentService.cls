public with sharing class OrderFulfillmentService {
    public class FulfillmentException extends Exception {
    }

    /** Return orders that are ready to leave the warehouse. */
    public static List<Order__c> pendingFor(Id accountId, Integer batchSize) {
        if (accountId == null) {
            throw new FulfillmentException('Account id is required');
        }

        return [
            SELECT Id, Account__c, Status__c, Warehouse__c
            FROM Order__c
            WHERE Account__c = :accountId
              AND Status__c = 'Ready'
            ORDER BY CreatedDate ASC
            LIMIT :batchSize
        ];
    }

    /** Mark a batch as fulfilled and emit one audit event per order. */
    public static void fulfill(Set<Id> orderIds) {
        if (orderIds == null || orderIds.isEmpty()) {
            return;
        }

        List<Order__c> orders = [
            SELECT Id, Status__c, Account__c
            FROM Order__c
            WHERE Id IN :orderIds
            FOR UPDATE
        ];

        List<Order_Audit__e> events = new List<Order_Audit__e>();
        for (Order__c order : orders) {
            order.Status__c = 'Fulfilled';
            events.add(new Order_Audit__e(
                Order_Id__c = order.Id,
                Action__c = 'fulfilled'
            ));
        }

        update orders;
        EventBus.publish(events);
    }

    private static Map<Id,Account> accountsFor(Set<Id> accountIds) {
        Map<Id,Account> result = new Map<Id,Account>();
        for (Account account : [
            SELECT Id, Name, ShippingCountry
            FROM Account
            WHERE Id IN :accountIds
        ]) {
            result.put(account.Id, account);
        }
        return result;
    }

    public static Integer countArchived(String region) {
        String query = 'SELECT Id FROM Order__c WHERE Status__c = \'Archived\'';
        if (String.isNotBlank(region)) {
            query += ' AND Region__c = :region';
        }
        return Database.query(query).size();
    }
}
