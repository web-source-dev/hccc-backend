const mongoose = require('mongoose');

const winnersSchema = new mongoose.Schema({
    name: { type: String },
    email: { type: String },
    phone: { type: String },
    location: { type: String },
    game:{
        type:mongoose.Schema.Types.ObjectId,
        ref:'Game',
    },
    amount:{
        type:Number,
    },
    date:{
        type:Date,
    },
    showWinner:{
        type:Boolean,
        default:false
    }
},
{
    timestamps:true
});

const Winners = mongoose.model('Winners', winnersSchema);

module.exports = Winners;