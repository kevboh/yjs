/* @flow */

// Op is anything that we could get from the OperationStore.
type Op = Object;
type Id = [string, number];

type List = {
  id: Id,
  start: Insert,
  end: Insert
};

type Insert = {
  id: Id,
  left: Insert,
  right: Insert,
  origin: Insert,
  parent: List,
  content: any
};

function compareIds(id1, id2) {
  if (id1 == null) {
    if (id2 == null) {
      return true;
    } else {
      return false;
    }
  }
  if (id1[0] === id2[0] && id1[1] === id2[1]) {
    return true;
  } else {
    return false;
  }
}

var Struct = {
  Operation: {  //eslint-disable-line no-unused-vars
    create: function*(op : Op) : Struct.Operation {
      var user = this.store.y.connector.userId;
      var state = yield* this.getState(user);
      op.id = [user, state.clock];
      if ((yield* this.addOperation(op)) === false) {
        throw new Error("This is highly unexpected :(");
      }
      this.store.y.connector.broadcast({
        type: "update",
        ops: [Struct[op.struct].encode(op)]
      });
    }
  },
  Insert: {
    /*{
        content: any,
        left: Id,
        right: Id,
        parent: Id,
        parentSub: string (optional)
      }
    */
    create: function*( op: Op ) : Insert {
      if ( op.left === undefined
        || op.right === undefined
        || op.parent === undefined ) {
          throw new Error("You must define left, right, and parent!");
        }
      op.origin = op.left;
      op.struct = "Insert";
      yield* Struct.Operation.create.call(this, op);

      if (op.left != null) {
        var left = yield* this.getOperation(op.left);
        left.right = op.id;
        yield* this.setOperation(left);
      }
      if (op.right != null) {
        var right = yield* this.getOperation(op.right);
        right.left = op.id;
        yield* this.setOperation(right);
      }
      var parent = yield* this.getOperation(op.parent);
      if (op.parentSub != null){
        if (compareIds(parent.map[op.parentSub], op.right)) {
          parent.map[op.parentSub] = op.id;
          yield* this.setOperation(parent);
        }
      } else {
        var start = compareIds(parent.start, op.right);
        var end = compareIds(parent.end, op.left);
        if (start || end) {
          if (start) {
            parent.start = op.id;
          }
          if (end) {
            parent.end = op.id;
          }
          yield* this.setOperation(parent);
        }
      }
      return op;
    },
    encode: function(op){
      /*var e = {
        id: op.id,
        left: op.left,
        right: op.right,
        origin: op.origin,
        parent: op.parent,
        content: op.content,
        struct: "Insert"
      };
      if (op.parentSub != null){
        e.parentSub = op.parentSub;
      }
      return e;*/
      return op;
    },
    requiredOps: function(op){
      var ids = [];
      if(op.left != null){
        ids.push(op.left);
      }
      if(op.right != null){
        ids.push(op.right);
      }
      if(op.right == null && op.left == null) {
        ids.push(op.parent);
      }
      return ids;
    },
    getDistanceToOrigin: function *(op){
      var d = 0;
      var o = yield* this.getOperation(op.left);
      while (op.origin !== (o ? o.id : null)) {
        d++;
        o = yield* this.getOperation(o.left);
      }
      return d;
    },
    /*
    # $this has to find a unique position between origin and the next known character
    # case 1: $origin equals $o.origin: the $creator parameter decides if left or right
    #         let $OL= [o1,o2,o3,o4], whereby $this is to be inserted between o1 and o4
    #         o2,o3 and o4 origin is 1 (the position of o2)
    #         there is the case that $this.creator < o2.creator, but o3.creator < $this.creator
    #         then o2 knows o3. Since on another client $OL could be [o1,o3,o4] the problem is complex
    #         therefore $this would be always to the right of o3
    # case 2: $origin < $o.origin
    #         if current $this insert_position > $o origin: $this ins
    #         else $insert_position will not change
    #         (maybe we encounter case 1 later, then this will be to the right of $o)
    # case 3: $origin > $o.origin
    #         $this insert_position is to the left of $o (forever!)
    */
    execute: function*(op){
      var i; // loop counter
      var distanceToOrigin = i = yield* Struct.Insert.getDistanceToOrigin.call(this, op); // most cases: 0 (starts from 0)
      var o;

      // find o. o is the first conflicting operation
      if (op.left != null) {
        o = yield* this.getOperation(op.left);
        o = yield* this.getOperation(o.right);
      } else if (op.right != null) {
        o = yield* this.getOperation(op.right);
        while (o.left != null){
          o = yield* this.getOperation(o.left);
        }
      } else { // left & right are null
        var p = yield* this.getOperation(op.parent);
        if (op.parentSub != null) {
          o = yield* this.getOperation(p.map[op.parentSub]);
        } else {
          o = yield* this.getOperation(p.start);
        }
      }

      // handle conflicts
      while (true) {
        if (o != null && o.id !== op.right){
          var oOriginDistance = yield* Struct.Insert.getDistanceToOrigin.call(this, o);
          if (oOriginDistance === i) {
            // case 1
            if (o.id[0] < op.id[0]) {
              op.left = o.id;
              distanceToOrigin = i + 1;
            }
          } else if (oOriginDistance < i) {
            // case 2
            if (i - distanceToOrigin <= oOriginDistance) {
              op.left = o.id;
              distanceToOrigin = i + 1;
            }
          } else {
            break;
          }
          i++;
          o = yield* this.getOperation(o.next_cl);
        } else {
          break;
        }
      }

      // reconnect..
      var left = null;
      var right = null;
      var parent = yield* this.getOperation(op.parent);

      // NOTE: You you have to call addOperation before you set any other operation!

      // reconnect left and set right of op
      if (op.left != null) {
        left = yield* this.getOperation(op.left);
        op.right = left.right;
        left.right = op.id;
        if ((yield* this.addOperation(op)) === false) { // add here
          return;
        }
        yield* this.setOperation(left);
      } else {
        if ((yield* this.addOperation(op)) === false) { // or here
          return;
        }
        // only set right, if possible
        if (op.parentSub != null) {
          var sub = parent[op.parentSub];
          op.right = sub != null ? sub : null;
        } else {
          op.right = parent.start;
        }
      }
      // reconnect right
      if (op.right != null) {
        right = yield* this.getOperation(op.right);
        right.left = op.id;
        yield* this.setOperation(right);
      }

      // notify parent
      if (op.parentSub != null) {
        if (left == null) {
          parent.map[op.parentSub] = op.id;
          yield* this.setOperation(parent);
        }
      } else {
        if (right == null || left == null) {
          if (right == null) {
            parent.end = op.id;
          }
          if (left == null) {
            parent.start = op.id;
          }
          yield* this.setOperation(parent);
        }
      }
    }
  },
  List: {
    create: function*( op : Op){
      op.start = null;
      op.end = null;
      op.struct = "List";
      return yield* Struct.Operation.create.call(this, op);
    },
    encode: function(op){
      return {
        struct: "List",
        id: op.id
      };
    },
    requiredOps: function(op){
      var ids = [];
      if (op.start != null) {
        ids.push(op.start);
      }
      if (op.end != null){
        ids.push(op.end);
      }
      return ids;
    },
    execute: function* (op) {
      if ((yield* this.addOperation(op)) === false) {
        return;
      }
    },
    ref: function* (op : Op, pos : number) : Insert {
      var o = op.start;
      while ( pos !== 0 || o != null) {
        o = (yield* this.getOperation(o)).right;
        pos--;
      }
      return (o == null) ? null : yield* this.getOperation(o);
    },
    map: function* (o : Op, f : Function) : Array<any> {
      o = o.start;
      var res = [];
      while ( o != null) {
        var operation = yield* this.getOperation(o);
        res.push(f(operation.content));
        o = operation.right;
      }
      return res;
    },
    insert: function* (op, pos : number, contents : Array<any>) {
      var o = yield* Struct.List.ref.call(this, op, pos);
      var or = yield* this.getOperation(o.right);
      for (var key in contents) {
        var insert = {
          left: o,
          right: or,
          content: contents[key],
          parent: op
        };
        o = yield* Struct.Insert.create.call(this, insert);
      }
    }
  },
  Map: {
    /*
      {
        // empty
      }
    */
    create: function*( op : Op ){
      op.map = {};
      op.struct = "Map";
      return yield* Struct.Operation.create.call(this, op);
    },
    encode: function(op){
      return {
        struct: "Map",
        id: op.id
      };
    },
    requiredOps: function(op){
      var ids = [];
      for (var end in op.map) {
        ids.push(op.map[end]);
      }
      return ids;
    },
    execute: function* (op) {
      if ((yield* this.addOperation(op)) === false) {
        return;
      }
    },
    get: function* (op, name) {
      var res = yield* this.getOperation(op.map[name]);
      return (res != null) ? res.content : void 0;
    },
    set: function* (op, name, value) {
      var insert = {
        left: null,
        right: op.map[name] || null,
        content: value,
        parent: op.id,
        parentSub: name
      };
      yield* Struct.Insert.create.call(this, insert);
    }
  }
};

Y.Struct = Struct;
