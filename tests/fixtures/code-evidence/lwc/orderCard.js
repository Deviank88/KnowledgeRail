import { LightningElement, api, wire } from "lwc";
import { getRecord } from "lightning/uiRecordApi";

export default class OrderCard extends LightningElement {
  // @wire(fakeAdapter) is documentation, not a decorator.
  @api recordId;
  @wire(getRecord, { recordId: "$recordId" }) order;
}
