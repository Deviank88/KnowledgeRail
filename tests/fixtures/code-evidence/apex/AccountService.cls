@RestResource(urlMapping='/accounts/*')
global with sharing class AccountService {
  /** Load one account through the REST resource. */
  @HttpGet
  global static Account loadAccount() {
    Account record = [SELECT Id, Name FROM Account LIMIT 1];
    return record;
  }
}
